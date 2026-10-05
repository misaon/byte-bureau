// At the cap of ten imported modules (import/max-dependencies): a further dependency goes into a helper module beside it
import type {
  AgentEvent,
  AgentSession,
  AskAnswer,
  ExternalSessionRef,
  PromptInput,
} from '@bytebureau/plugin-api'
import { startAgent, terminalEnvOf, toldReason, type Setup } from './agent-start.js'
import { Terminals } from './client-terminal.js'
import type { ClientHandlers, Running } from './connection.js'
import { endProcess, sweepGroup } from './kill-ladder.js'
import { PermissionBroker } from './permissions.js'
import { endingOf } from './process.js'
import { Queue } from './queue.js'
import { clientOf } from './session-client.js'
import {
  answeredIn,
  cancelTurn,
  completionOf,
  crashMessageOf,
  crashOf,
  hasExited,
  MAX_RESTARTS,
  newTurn,
  notLoadedOf,
  promptOf,
  quietly,
  refusalOf,
  restartOf,
  toldOf,
  type Turn,
} from './session-turns.js'

// One ACP agent at a time serves the session: a prompt is a session/prompt, the agent's updates are the events
// An agent that dies idle is started again by the next prompt, three times at most; one that dies mid-turn ends the session
export class AcpSession implements AgentSession {
  private readonly setup: Setup
  private readonly output = new Queue<AgentEvent>()
  private readonly asks: PermissionBroker
  private readonly terminals: Terminals
  private running: Running | undefined
  // The prompt in progress, from the moment it is asked for, its agent started again if need be
  private turn: Turn | undefined
  // The turn an agent was sent and has not answered: its death in the meantime is a crash of the turn
  private owing: { readonly running: Running; readonly turn: Turn } | undefined
  private ref: string | undefined
  private restarts = 0
  private closed = false
  // The watch on the agent that runs, and the start of an agent under way, which close() waits for
  private watching: Promise<void> = Promise.resolve()
  private launching: Promise<void> = Promise.resolve()

  private constructor(setup: Setup) {
    this.setup = setup
    const { request, deps } = setup
    const tell = (event: AgentEvent): void => {
      this.output.push(event)
    }
    this.asks = new PermissionBroker(request.sessionId, tell, () => this.interrupted())
    this.terminals = new Terminals(deps.process, request.workspace.path, terminalEnvOf(setup))
  }

  // The session of a request: its agent started, the session it resumes loaded when that is one of this provider
  public static async start(setup: Setup): Promise<AcpSession> {
    const session = new AcpSession(setup)
    const { resume } = setup.request
    const own = resume !== undefined && resume.providerId === setup.providerId
    await session.launch(own ? resume.ref : undefined)
    return session
  }

  public get externalRef(): ExternalSessionRef | null {
    return this.ref === undefined ? null : { providerId: this.setup.providerId, ref: this.ref }
  }

  public async prompt(input: PromptInput): Promise<void> {
    const turn = newTurn()
    this.turn = turn
    try {
      const running = await this.alive()
      if (running !== undefined) {
        await this.run(running, turn, input.text)
      }
    } finally {
      if (this.turn === turn) {
        this.turn = undefined
      }
    }
  }

  // What waits for an answer is moot once the turn is interrupted; a turn whose prompt is out is cancelled now, one still starting right after its prompt
  public async interrupt(): Promise<void> {
    const { turn, owing } = this
    if (turn !== undefined) {
      turn.interrupted = true
    }
    this.asks.cancelAll()
    if (owing !== undefined && owing.turn === turn) {
      await cancelTurn(owing.running)
    }
  }

  public async answer(askId: string, answer: AskAnswer): Promise<void> {
    await Promise.resolve()
    this.asks.answer(askId, answer)
  }

  public events(): AsyncIterable<AgentEvent> {
    return this.output
  }

  // A running turn is cancelled, the agent ended by the ladder, then its terminals; the events end with session.closed
  // An agent still starting is ended once it has started, before close() is done
  public async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.asks.cancelAll()
      await this.stop(this.running)
      this.terminals.close()
      this.finish([{ type: 'session.closed' }])
    }
    await this.launching
    await this.watching
  }

  private async launch(resume?: string): Promise<void> {
    const launched = this.started(resume)
    this.launching = quietly(launched)
    await launched
  }

  private async started(resume?: string): Promise<void> {
    const running = await startAgent(this.setup, this.handlers(), resume)
    if (this.closed) {
      await this.stop(running)
      return
    }
    this.running = running
    this.ref = running.sessionId
    this.watching = this.watch(running)
    if (resume !== undefined && running.notLoaded !== undefined) {
      this.output.push(notLoadedOf(resume, running.notLoaded))
    }
  }

  // The agent that runs, started again when it died idle; none once the session has ended
  private async alive(): Promise<Running | undefined> {
    const { running } = this
    if (running !== undefined && hasExited(running)) {
      await this.died(running)
    }
    if (!this.closed && this.running === undefined) {
      this.restarts += 1
      this.output.push(restartOf(this.restarts))
      await this.launch()
    }
    return this.closed ? undefined : this.running
  }

  // The turn on the agent: owed until its answer comes
  private async run(running: Running, turn: Turn, text: string): Promise<void> {
    this.output.push({ type: 'turn.started' })
    this.owing = { running, turn }
    try {
      const response = await promptOf(running, turn, text)
      this.paid(turn, completionOf(turn, response))
    } catch (error) {
      await this.failed(running, turn, error)
    }
  }

  private interrupted(): boolean {
    return this.turn !== undefined && this.turn.interrupted
  }

  private async stop(running: Running | undefined): Promise<void> {
    if (running !== undefined) {
      if (this.owing !== undefined && this.owing.running === running) {
        await cancelTurn(running)
      }
      await endProcess(running.process.child, running.process.exited)
      running.connection.close()
    }
  }

  private async watch(running: Running): Promise<void> {
    await running.process.exited
    await this.died(running)
  }

  // A death is told once: mid-turn it ends the session, idle it leaves the next prompt to start another agent, three times at most
  private async died(running: Running): Promise<void> {
    if (running.gone || this.closed) {
      return
    }
    running.gone = true
    this.running = undefined
    const midTurn = await this.owedBy(running)
    this.release(running)
    await this.afterDeath(running, midTurn)
  }

  // The next prompt starts another agent, unless the session closed meanwhile, or the agent died mid-turn or once too often
  private async afterDeath(running: Running, midTurn: boolean): Promise<void> {
    if (this.closed || (!midTurn && this.restarts < MAX_RESTARTS)) {
      return
    }
    this.closed = true
    await this.crashed(running, midTurn)
  }

  // Whether the agent died owing the turn it was sent, which the turn's own answer decides: an answer that came is no crash, however close the death
  private async owedBy(running: Running): Promise<boolean> {
    const { owing } = this
    return owing !== undefined && owing.running === running && !(await answeredIn(owing.turn))
  }

  // What the agent held is let go, once its last answer is read: what is left of its group, its connection, what it asked, its terminals
  private release(running: Running): void {
    sweepGroup(running.process.child)
    running.connection.close()
    this.asks.cancelAll()
    this.terminals.releaseAll()
  }

  private async crashed(running: Running, midTurn: boolean): Promise<void> {
    const exit = await running.process.exited
    const ending = endingOf(running.process, exit)
    const reason = crashMessageOf(ending, midTurn)
    const named = { sessionId: this.setup.request.sessionId, ref: running.sessionId, reason }
    this.setup.deps.logger.warn('the ACP agent of a session exited', named)
    this.finish(crashOf(reason, midTurn))
  }

  // A prompt that failed: an agent that has gone or is going tells it by its death; else it refused the prompt, and the session goes on
  private async failed(running: Running, turn: Turn, error: unknown): Promise<void> {
    if (running.gone || this.closed) {
      return
    }
    if (running.connection.signal.aborted) {
      await endProcess(running.process.child, running.process.exited)
      return
    }
    this.paid(turn, refusalOf(turn, toldReason(error, this.setup)))
  }

  // A turn the agent answered is no longer owed, and ends with what the answer tells
  private paid(turn: Turn, events: readonly AgentEvent[]): void {
    if (this.owing !== undefined && this.owing.turn === turn) {
      this.owing = undefined
    }
    this.tell(events)
  }

  private finish(events: readonly AgentEvent[]): void {
    this.tell(events)
    this.output.end()
  }

  private tell(events: readonly AgentEvent[]): void {
    for (const event of events) {
      this.output.push(event)
    }
  }

  // Updates are told only while the agent is the session's: what a load replays before is history the session already told
  private handlers(): ClientHandlers {
    return clientOf({
      workspace: this.setup.request.workspace.path,
      asks: this.asks,
      terminals: this.terminals,
      updated: (notification) => {
        if (this.running !== undefined) {
          this.tell(toldOf(notification, this.turn))
        }
      },
    })
  }
}
