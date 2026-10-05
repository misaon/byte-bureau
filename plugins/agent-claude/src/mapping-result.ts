import type {
  ModelUsage,
  NonNullableUsage,
  SDKContextUsage,
  SDKRateLimitInfo,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, RateLimit, Usage } from '@bytebureau/protocol'

interface Totals {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costUsd: number
}

// What the mapping of one query remembers from one message to the next
export interface MapState {
  sessionId: string | undefined
  turnStarted: boolean
  contextPct: number | undefined
  // The SDK reports the totals of the whole query with every result; a turn is told the difference
  // Unknown at the start of a resumed query, whose first result also carries the totals of the session it resumed
  totals: Totals | undefined
  // Each event names one window; both are told together
  rateLimit: RateLimit
}

const NO_TOTALS: Totals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
}

export const newMapState = (resumed = false): MapState => ({
  sessionId: undefined,
  turnStarted: false,
  contextPct: undefined,
  totals: resumed ? undefined : NO_TOTALS,
  rateLimit: {},
})

const sum = (models: readonly ModelUsage[], pick: (model: ModelUsage) => number): number =>
  models.reduce((total, model) => total + pick(model), 0)

// A result without the usage of any model carries zeroed totals, which are no news
const totalsOf = (message: SDKResultMessage, before: Totals | undefined): Totals | undefined => {
  const models = Object.values(message.modelUsage)
  if (models.length === 0) {
    return before
  }
  return {
    inputTokens: sum(models, (model) => model.inputTokens),
    outputTokens: sum(models, (model) => model.outputTokens),
    cacheReadTokens: sum(models, (model) => model.cacheReadInputTokens),
    cacheWriteTokens: sum(models, (model) => model.cacheCreationInputTokens),
    costUsd: message.total_cost_usd,
  }
}

// A total that went down was reset by a /clear, so all of it is new
const since = (before: number, now: number): number => (now >= before ? now - before : now)

const difference = (before: Totals, now: Totals): Usage => ({
  inputTokens: since(before.inputTokens, now.inputTokens),
  outputTokens: since(before.outputTokens, now.outputTokens),
  cacheReadTokens: since(before.cacheReadTokens, now.cacheReadTokens),
  cacheWriteTokens: since(before.cacheWriteTokens, now.cacheWriteTokens),
  costUsd: since(before.costUsd, now.costUsd),
})

// The usage the result gives of its own turn: the main loop only, without subagents or a cost
const ownUsage = (usage: NonNullableUsage): Usage => ({
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  cacheReadTokens: usage.cache_read_input_tokens,
  cacheWriteTokens: usage.cache_creation_input_tokens,
})

const ABORTED: ReadonlySet<string> = new Set(['aborted_streaming', 'aborted_tools'])

const isAborted = (message: SDKResultMessage): boolean =>
  message.terminal_reason !== undefined && ABORTED.has(message.terminal_reason)

// An interrupted turn ends with an aborted terminal reason; a failed one is told by its subtype or its terminal reason
const stopReasonOf = (message: SDKResultMessage): string => {
  if (isAborted(message)) {
    return 'interrupted'
  }
  if (message.subtype !== 'success') {
    return message.subtype
  }
  return message.is_error
    ? (message.terminal_reason ?? 'error')
    : (message.stop_reason ?? 'end_turn')
}

// A turn the API failed is a success that is an error, and its text says why; the session stays for a retry
const failureOf = (message: SDKResultMessage): readonly AgentEvent[] => {
  if (message.subtype !== 'success' || !message.is_error || isAborted(message)) {
    return []
  }
  const text = message.result === '' ? 'the turn ended on an error' : message.result
  return [{ type: 'session.warning', kind: 'turn_error', message: text }]
}

// The first turn of a resumed query is told by its own usage; from then on the totals are known
export const mapResult = (message: SDKResultMessage, state: MapState): readonly AgentEvent[] => {
  const before = state.totals
  const now = totalsOf(message, before)
  const counted =
    before === undefined || now === undefined ? ownUsage(message.usage) : difference(before, now)
  const { contextPct } = state
  const usage = contextPct === undefined ? counted : { ...counted, contextPct }
  state.totals = now
  state.turnStarted = false
  state.contextPct = undefined
  return [
    ...failureOf(message),
    { type: 'usage.updated', usage },
    { type: 'turn.completed', stopReason: stopReasonOf(message), usage },
  ]
}

export const contextPctOf = (usage: SDKContextUsage): number =>
  usage.raw_max_tokens > 0 ? (usage.total_tokens / usage.raw_max_tokens) * 100 : usage.percentage

const isoOf = (seconds: number): string => new Date(seconds * 1000).toISOString()

const fiveHourOf = ({ utilization, resetsAt }: SDKRateLimitInfo): RateLimit => ({
  ...(utilization === undefined ? {} : { fiveHourPct: utilization * 100 }),
  ...(resetsAt === undefined ? {} : { fiveHourResetsAt: isoOf(resetsAt) }),
})

const sevenDayOf = ({ utilization, resetsAt }: SDKRateLimitInfo): RateLimit => ({
  ...(utilization === undefined ? {} : { sevenDayPct: utilization * 100 }),
  ...(resetsAt === undefined ? {} : { sevenDayResetsAt: isoOf(resetsAt) }),
})

// The window an event tells of; the overage and an untyped event tell of none
const windowOf = (info: SDKRateLimitInfo): RateLimit => {
  const type = info.rateLimitType ?? ''
  if (type === 'five_hour') {
    return fiveHourOf(info)
  }
  return type.startsWith('seven_day') ? sevenDayOf(info) : {}
}

const LIMIT_REACHED: AgentEvent = {
  type: 'session.error',
  kind: 'ratelimit',
  message: 'the usage limit is reached',
  retryable: true,
}

export const mapRateLimit = (info: SDKRateLimitInfo, state: MapState): readonly AgentEvent[] => {
  const window = windowOf(info)
  const told: AgentEvent[] = []
  if (Object.keys(window).length > 0) {
    state.rateLimit = { ...state.rateLimit, ...window }
    told.push({ type: 'ratelimit.updated', rateLimit: state.rateLimit })
  }
  // A subscriber past the limit whose extra usage serves the turns goes on: the CLI says isUsingOverage
  if (info.status === 'rejected' && info.isUsingOverage !== true) {
    told.push(LIMIT_REACHED)
  }
  return told
}
