import type {
  CanUseTool,
  HookCallbackMatcher,
  HookInput,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentSession,
  AskAnswer,
  CreateSessionRequest,
  ExternalSessionRef,
  Logger,
} from '@bytebureau/plugin-api'
import type { AgentEvent, PromptInput } from '@bytebureau/protocol'
import { AskBroker } from './asks.js'
import { mapMessage, measuredPctOf, newMapState, unreadResult, type MapState } from './mapping.js'
import { claudeResumeOf, optionsOf, UNTRUSTED_SETTINGS } from './options.js'
import { startQuery, type AgentQuery, type ClaudeDeps } from './deps.js'
import { Queue } from './queue.js'
import { withinLimit } from './within-limit.js'

type SubagentEvent = 'subagent.started' | 'subagent.stopped'

const CONTEXT_LIMIT_MS = 5000

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// One query spans the session: prompts are user messages pushed into its input, its messages become the events
// No follow-up reaches a running turn: the kernel refuses a prompt while one runs (409), though the SDK would queue it
export class ClaudeSession implements AgentSession {
  private readonly input = new Queue<SDKUserMessage>()
  private readonly output = new Queue<AgentEvent>()
  private readonly abort = new AbortController()
  private readonly state: MapState
  private readonly asks: AskBroker
  private readonly logger: Logger
  // The kernel's id of the session, which a warning names beside the reference of Claude's session
  private readonly sessionId: string
  private readonly query: AgentQuery
  // Settles once every message of the query is read and the events have ended
  public readonly ended: Promise<void>
  private closed = false

  public constructor(
    deps: ClaudeDeps,
    request: CreateSessionRequest,
    executable: string | undefined,
  ) {
    this.asks = new AskBroker(request.sessionId)
    this.logger = deps.logger
    this.sessionId = request.sessionId
    this.state = newMapState(claudeResumeOf(request) !== undefined)
    const parts = {
      request,
      executable,
      abort: this.abort,
      hooks: this.hooks(),
      canUseTool: this.canUseTool,
    }
    this.untrusted(request)
    this.query = startQuery(deps, { prompt: this.input, options: optionsOf(parts) })
    this.ended = this.read()
  }

  // A project the user does not trust runs without its own settings, which the session tells first, and logs
  private untrusted({ trust, sessionId }: CreateSessionRequest): void {
    if (!trust.project) {
      this.logger.warn(UNTRUSTED_SETTINGS, { sessionId })
      this.output.push({ type: 'session.warning', kind: 'trust', message: UNTRUSTED_SETTINGS })
    }
  }

  public get externalRef(): ExternalSessionRef | null {
    return this.state.sessionId === undefined
      ? null
      : { providerId: 'claude', ref: this.state.sessionId }
  }

  public async prompt(input: PromptInput): Promise<void> {
    await Promise.resolve()
    this.input.push({
      type: 'user',
      message: { role: 'user', content: input.text },
      parent_tool_use_id: null,
    })
  }

  // The asks of the turn are moot once it is interrupted; the agent ends the turn with a result
  public async interrupt(): Promise<void> {
    this.asks.denyAll('interrupted')
    await this.query.interrupt()
  }

  public async answer(askId: string, answer: AskAnswer): Promise<void> {
    await Promise.resolve()
    this.asks.answer(askId, answer)
  }

  public async setModel(model: string): Promise<void> {
    await this.query.setModel(model)
  }

  public events(): AsyncIterable<AgentEvent> {
    return this.output
  }

  public async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.asks.denyAll('closed')
      this.input.end()
      this.abort.abort()
      this.query.close()
      this.output.push({ type: 'session.closed' })
      this.output.end()
    }
    await Promise.resolve()
  }

  // The SDK waits for the answer; the ask is told at once, so the kernel can open it
  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const { requestId, toolUseID, signal } = options
    const pending = this.asks.ask(toolName, input, { requestId, toolUseID, signal })
    this.tell(this.asks.drain())
    const result = await pending
    return result
  }

  private hooks(): Partial<Record<'SubagentStart' | 'SubagentStop', HookCallbackMatcher[]>> {
    const telling = (type: SubagentEvent): HookCallbackMatcher[] => [
      {
        hooks: [
          async (input) => {
            await Promise.resolve()
            this.tellSubagent(type, input)
            return {}
          },
        ],
      },
    ]
    return { SubagentStart: telling('subagent.started'), SubagentStop: telling('subagent.stopped') }
  }

  private tellSubagent(type: SubagentEvent, input: HookInput): void {
    if (input.hook_event_name === 'SubagentStart' || input.hook_event_name === 'SubagentStop') {
      this.output.push({ type, id: input.agent_id, name: input.agent_type })
    }
  }

  private tell(events: readonly AgentEvent[]): void {
    for (const event of events) {
      this.output.push(event)
    }
  }

  // The messages of the SDK, read for as long as the query gives them; a query that fails is a crash of the session
  private async read(): Promise<void> {
    try {
      for await (const message of this.query) {
        if (message.type === 'result') {
          await this.measureContext()
        }
        this.tell(this.mapped(message))
      }
    } catch (error) {
      this.crashed(error)
    } finally {
      this.output.push({ type: 'session.closed' })
      this.output.end()
    }
  }

  // The share of the context a turn left in use, asked after every turn by a summary that makes no request
  // A measure that fails or takes more than 5 s leaves the turn with what the SDK told during it, if anything
  private async measureContext(): Promise<void> {
    try {
      const measured = await withinLimit(
        this.query.getContextUsage({ detail: 'summary' }),
        CONTEXT_LIMIT_MS,
      )
      if (measured !== null) {
        this.state.contextPct = measuredPctOf(measured)
      }
    } catch {
      // Not measured: the turn keeps what it had
    }
  }

  // A message the mapping cannot read is told as a warning and the session goes on; a result still ends its turn
  private mapped(message: SDKMessage): readonly AgentEvent[] {
    try {
      return mapMessage(message, this.state)
    } catch (error) {
      const warning: AgentEvent = {
        type: 'session.warning',
        kind: 'mapping',
        message: reasonOf(error),
      }
      return message.type === 'result' ? [warning, unreadResult(message, this.state)] : [warning]
    }
  }

  // A failure after close is the close itself
  private crashed(error: unknown): void {
    if (!this.closed) {
      const message = reasonOf(error)
      this.output.push({ type: 'session.error', kind: 'crash', message, retryable: true })
      const ref = this.state.sessionId === undefined ? {} : { ref: this.state.sessionId }
      const named = { sessionId: this.sessionId, ...ref, reason: message }
      this.logger.warn('the Claude query ended with an error', named)
    }
  }
}
