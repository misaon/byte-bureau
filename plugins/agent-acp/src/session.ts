// At the cap of ten imported modules (import/max-dependencies): a further dependency goes into a helper module beside it
import type {
  AgentEvent,
  AgentSession,
  AskAnswer,
  ExternalSessionRef,
  PromptInput,
} from '@bytebureau/plugin-api'
import {
  relaunchOf,
  startAgent,
  terminalEnvOf,
  toldReason,
  type Launching,
  type Setup,
} from './agent-start.js'
import { Terminals } from './client-terminal.js'
import { reasonOf, type ClientHandlers, type Running } from './connection.js'
import { endProcess, sweepGroup } from './kill-ladder.js'
import { PermissionBroker } from './permissions.js'
import { endingOf } from './process.js'
import { Queue } from './queue.js'
import { clientOf } from './session-client.js'
import {
  cancelTurn,
  completionOf,
  crashMessageOf,
  crashOf,
  hasExited,
  MAX_RESTARTS,
  newTurn,
  notLoadedOf,
  owedBy,
  promptOf,
  quietly,
  refusalOf,
  restartOf,
  stopAgent,
  toldOf,
  type Owing,
  type Turn,
} from './session-turns.js'

// One ACP agent at a time serves the session: a prompt is a session/prompt, the agent's updates are the events
// An agent that dies idle is started again by the next prompt, three times at most; one that dies mid-turn ends the session
export class AcpSession implements AgentSession {
  private readonly setup: Setup
  private readonly output = new Queue<AgentEvent>()
  private readonly asks: PermissionBroker
  private readonly terminals: Terminals
  private readonly client: ClientHandlers
  // Gives up a start under way when the session closes
  private readonly ending = new AbortController()
  private running: Running | undefined
  // The prompt in progress, from the moment it is asked for, its agent started again if need be
  private turn: Turn | undefined
  // The turn an agent was sent and has not answered: its death in the meantime is a crash of the turn
  private owing: Owing | undefined
  private ref: string | undefined
  private restarts = 0
  private closed = false
  // The watch on the agent that runs, and the start of an agent under way, which close() waits for
  private watching: Promise<void> = Promise.resolve()
  private launching: Promise<void> = Promise.resolve()
  // The death of an agent being decided, which a prompt that notices it waits for
  private dying: Promise<void> = Promise.resolve()

  private constructor(setup: Setup) {
    this.setup = setup
    const { request, deps } = setup
    const tell = (event: AgentEvent): void => {
      this.output.push(event)
    }
    const interrupted = (): boolean => this.turn !== undefined && this.turn.interrupted
    this.asks = new PermissionBroker(request.sessionId, tell, interrupted)
    this.terminals = new Terminals(deps.process, request.workspace.path, terminalEnvOf(setup))
    // Updates are told only while the agent is the session's: what a load replays before is history the session already told
    const updated: ClientHandlers['sessionUpdate'] = (notification) => {
      if (this.running !== undefined) {
        this.tell(toldOf(notification, this.turn))
      }
    }
    const { asks, terminals } = this
    this.client = clientOf({ workspace: request.workspace.path, asks, terminals, updated })
  }

  // The session of a request: its agent started, the session it resumes loaded when that is one of this provider
  public static async start(setup: Setup): Promise<AcpSession> {
    const session = new AcpSession(setup)
    const { resume } = setup.request
    const own = resume !== undefined && resume.providerId === setup.providerId
    await session.launch({ resume: own ? resume.ref : undefined })
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
  // An agent still starting is given up, killed with its group, before close() is done
  public async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.ending.abort()
      this.asks.cancelAll()
      await stopAgent(this.running, this.owing)
      this.terminals.close()
      this.finish([{ type: 'session.closed' }])
    }
    await this.launching
    await this.watching
  }

  private async launch(starting: Launching): Promise<void> {
    const launched = this.started(starting)
    this.launching = quietly(launched)
    await launched
  }

  private async started(starting: Launching): Promise<void> {
    const signal = AbortSignal.any([this.setup.request.signal, this.ending.signal])
    const running = await startAgent(this.setup, this.client, { ...starting, signal })
    await this.adopted(running, starting.resume)
  }

  // An agent started for a session that closed meanwhile is ended; else it is the session's, watched, and a resume it could not load is told
  private async adopted(running: Running, resume: string | undefined): Promise<void> {
    if (this.closed) {
      await stopAgent(running, this.owing)
      return
    }
    this.running = running
    this.ref = running.sessionId
    this.watching = this.watch(running)
    this.tell(notLoadedOf(resume, running.notLoaded))
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
      await this.relaunched()
    }
    return this.closed ? undefined : this.running
  }

  // The agent started again loads the session of the one that died, where it loads sessions, else starts another and says so
  // One that cannot be started again ends the session as a crash a resume may retry; one that close() gave up on ends nothing more
  private async relaunched(): Promise<void> {
    try {
      await this.launch(relaunchOf(this.setup, this.ref))
    } catch (error) {
      if (!this.closed) {
        this.crashedWith('the ACP agent of a session could not start again', reasonOf(error), true)
      }
    }
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

  private async watch(running: Running): Promise<void> {
    await running.process.exited
    await this.died(running)
  }

  // A death is told once: mid-turn it ends the session, idle it leaves the next prompt to start another agent, three times at most
  // Whoever notices it as well waits for that
  private async died(running: Running): Promise<void> {
    if (this.closed) {
      return
    }
    if (!running.gone) {
      running.gone = true
      this.dying = this.deathOf(running)
    }
    await this.dying
  }

  // The agent stays the session's until its last answer is read, so the updates read meanwhile are still told
  private async deathOf(running: Running): Promise<void> {
    const midTurn = await owedBy(this.owing, running)
    if (this.running === running) {
      this.running = undefined
    }
    this.release(running)
    await this.afterDeath(running, midTurn)
  }

  // The next prompt starts another agent, unless the session closed meanwhile, or the agent died mid-turn or once too often
  private async afterDeath(running: Running, midTurn: boolean): Promise<void> {
    if (this.closed || (!midTurn && this.restarts < MAX_RESTARTS)) {
      return
    }
    this.closed = true
    const exit = await running.process.exited
    const reason = crashMessageOf(endingOf(running.process, exit), midTurn)
    this.crashedWith('the ACP agent of a session exited', reason, midTurn)
  }

  // What the agent held is let go, once its last answer is read: what is left of its group, its connection, what it asked, its terminals
  private release(running: Running): void {
    sweepGroup(running.process.child)
    running.connection.close()
    this.asks.cancelAll()
    this.terminals.releaseAll()
  }

  // The end of the session by a crash: its terminals closed, the reason logged and told, retryable or not
  private crashedWith(logged: string, reason: string, retryable: boolean): void {
    this.closed = true
    this.terminals.close()
    const named = { sessionId: this.setup.request.sessionId, ref: this.ref, reason }
    this.setup.deps.logger.warn(logged, named)
    this.finish(crashOf(reason, retryable))
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
}
