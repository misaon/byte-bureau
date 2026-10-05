import type {
  ModelUsage,
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
  totals: Totals
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

export const newMapState = (): MapState => ({
  sessionId: undefined,
  turnStarted: false,
  contextPct: undefined,
  totals: NO_TOTALS,
  rateLimit: {},
})

const sum = (models: readonly ModelUsage[], pick: (model: ModelUsage) => number): number =>
  models.reduce((total, model) => total + pick(model), 0)

// A result without the usage of any model carries zeroed totals, which are no news
const totalsOf = (message: SDKResultMessage, before: Totals): Totals => {
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

const turnUsage = (before: Totals, now: Totals, contextPct: number | undefined): Usage => ({
  inputTokens: since(before.inputTokens, now.inputTokens),
  outputTokens: since(before.outputTokens, now.outputTokens),
  cacheReadTokens: since(before.cacheReadTokens, now.cacheReadTokens),
  cacheWriteTokens: since(before.cacheWriteTokens, now.cacheWriteTokens),
  costUsd: since(before.costUsd, now.costUsd),
  ...(contextPct === undefined ? {} : { contextPct }),
})

const ABORTED: ReadonlySet<string> = new Set(['aborted_streaming', 'aborted_tools'])

// An interrupted turn ends with an aborted terminal reason; a failed one is told by its subtype
const stopReasonOf = (message: SDKResultMessage): string => {
  if (message.terminal_reason !== undefined && ABORTED.has(message.terminal_reason)) {
    return 'interrupted'
  }
  return message.subtype === 'success' ? (message.stop_reason ?? 'end_turn') : message.subtype
}

export const mapResult = (message: SDKResultMessage, state: MapState): readonly AgentEvent[] => {
  const now = totalsOf(message, state.totals)
  const usage = turnUsage(state.totals, now, state.contextPct)
  state.totals = now
  state.turnStarted = false
  state.contextPct = undefined
  return [
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
  if (info.status === 'rejected') {
    told.push(LIMIT_REACHED)
  }
  return told
}
