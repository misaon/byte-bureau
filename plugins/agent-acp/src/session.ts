import type {
  AgentEvent,
  AgentSession,
  AskAnswer,
  ExternalSessionRef,
  PromptInput,
} from '@bytebureau/plugin-api'
import { secretsOf, startAgent, type Setup } from './agent-start.js'
import { readTextFile, writeTextFile } from './client-fs.js'
import { Terminals } from './client-terminal.js'
import type { ClientHandlers, Running } from './connection.js'
import { endProcess } from './kill-ladder.js'
import { PermissionBroker } from './permissions.js'
import { endingOf } from './process.js'
import { Queue } from './queue.js'
import {
  cancelTurn,
  completionOf,
  crashMessageOf,
  crashOf,
  hasExited,
  MAX_RESTARTS,
  newTurn,
  promptOf,
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
  private turn: Turn | undefined
  private ref: string | undefined
  private restarts = 0
  private closed = false
  // The watch on the agent that runs, which close() waits for
  private watching: Promise<void> = Promise.resolve()

  private constructor(setup: Setup) {
    this.setup = setup
    const { request, deps } = setup
    this.asks = new PermissionBroker(request.sessionId, (event) => {
      this.output.push(event)
    })
    this.terminals = new Terminals(deps.process, request.workspace.path, request.env)
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
    const running = await this.alive()
    if (running === undefined) {
      return
    }
    const turn = newTurn()
    this.turn = turn
    this.output.push({ type: 'turn.started' })
    try {
      const response = await promptOf(running, input.text)
      this.ended(turn, completionOf(turn, response))
    } catch (error) {
      await this.failed(running, turn, error)
    }
  }

  // What waits for an answer is moot once the turn is interrupted; the agent ends the turn as cancelled
  public async interrupt(): Promise<void> {
    this.asks.cancelAll()
    const { running } = this
    if (running !== undefined && this.turn !== undefined) {
      await cancelTurn(running)
    }
  }

  public async answer(askId: string, answer: AskAnswer): Promise<void> {
    await Promise.resolve()
    this.asks.answer(askId, answer)
  }

  public events(): AsyncIterable<AgentEvent> {
    return this.output
  }

  // A running turn is cancelled, then the agent ended by the ladder; the events end with session.closed
  public async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.asks.cancelAll()
      this.terminals.releaseAll()
      await this.stop(this.running)
      this.finish([{ type: 'session.closed' }])
    }
    await this.watching
  }

  private async launch(resume?: string): Promise<void> {
    const running = await startAgent(this.setup, this.handlers(), resume)
    if (this.closed) {
      await this.stop(running)
      return
    }
    this.running = running
    this.ref = running.sessionId
    this.watching = this.watch(running)
  }

  // The agent that runs, started again when it died idle; none once the session has ended
  private async alive(): Promise<Running | undefined> {
    const { running } = this
    if (running !== undefined && hasExited(running)) {
      await this.died(running)
    }
    if (!this.closed && this.running === undefined) {
      this.output.push(restartOf(this.restarts))
      await this.launch()
    }
    return this.closed ? undefined : this.running
  }

  private async stop(running: Running | undefined): Promise<void> {
    if (running !== undefined) {
      if (this.turn !== undefined) {
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
    this.release(running)
    const midTurn = this.turn !== undefined
    if (!midTurn && this.restarts < MAX_RESTARTS) {
      this.restarts += 1
      return
    }
    this.closed = true
    await this.crashed(running, midTurn)
  }

  // What the agent held is let go: its connection, what it asked, its terminals
  private release(running: Running): void {
    running.gone = true
    this.running = undefined
    running.connection.close()
    this.asks.cancelAll()
    this.terminals.releaseAll()
  }

  private async crashed(running: Running, midTurn: boolean): Promise<void> {
    const exit = await running.process.exited
    const ending = endingOf(running.process, exit, secretsOf(this.setup))
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
    this.ended(turn, refusalOf(turn, error))
  }

  private ended(turn: Turn, events: readonly AgentEvent[]): void {
    if (this.turn === turn) {
      this.turn = undefined
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
    const workspace = this.setup.request.workspace.path
    return {
      sessionUpdate: (notification) => {
        if (this.running !== undefined) {
          this.tell(toldOf(notification, this.turn))
        }
      },
      requestPermission: async (params, signal) => {
        const response = await this.asks.request(params, signal)
        return response
      },
      readTextFile: async (params) => {
        const response = await readTextFile(workspace, params)
        return response
      },
      writeTextFile: async (params) => {
        const response = await writeTextFile(workspace, params)
        return response
      },
      createTerminal: async (params) => {
        const response = await this.terminals.create(params)
        return response
      },
      terminalOutput: (params) => this.terminals.output(params),
      waitForTerminalExit: async (params) => {
        const response = await this.terminals.waitForExit(params)
        return response
      },
      killTerminal: (params) => this.terminals.kill(params),
      releaseTerminal: (params) => this.terminals.release(params),
    }
  }
}
