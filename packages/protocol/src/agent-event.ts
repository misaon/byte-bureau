import { Schema } from 'effect'
import { Ask } from './ask.js'

const tagged = <const Tag extends string, Fields extends Schema.Struct.Fields>(
  type: Tag,
  fields: Fields,
): Schema.Struct<{ readonly type: Schema.Literal<Tag> } & Fields> =>
  Schema.Struct({ type: Schema.Literal(type), ...fields })

export const Usage = Schema.Struct({
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  cacheReadTokens: Schema.optionalKey(Schema.Int),
  cacheWriteTokens: Schema.optionalKey(Schema.Int),
  costUsd: Schema.optionalKey(Schema.Finite),
  contextPct: Schema.optionalKey(Schema.Finite),
})

export const RateLimit = Schema.Struct({
  fiveHourPct: Schema.optionalKey(Schema.Finite),
  fiveHourResetsAt: Schema.optionalKey(Schema.String),
  sevenDayPct: Schema.optionalKey(Schema.Finite),
  sevenDayResetsAt: Schema.optionalKey(Schema.String),
})

export const ToolKind = Schema.Literals(['builtin', 'mcp', 'bash', 'subagent', 'skill'])

export const AgentEvent = Schema.Union([
  tagged('turn.started', {}),
  tagged('message.delta', { kind: Schema.Literals(['text', 'thinking']), text: Schema.String }),
  tagged('message.completed', {
    role: Schema.Literals(['assistant', 'user']),
    content: Schema.Array(Schema.Unknown),
    text: Schema.String,
  }),
  tagged('tool.started', {
    id: Schema.String,
    name: Schema.String,
    kind: ToolKind,
    input: Schema.Unknown,
  }),
  tagged('tool.completed', {
    id: Schema.String,
    outputSummary: Schema.String,
    bytes: Schema.Int,
  }),
  tagged('tool.failed', { id: Schema.String, error: Schema.String }),
  tagged('subagent.started', { id: Schema.String, name: Schema.String }),
  tagged('subagent.stopped', { id: Schema.String, name: Schema.String }),
  tagged('ask.requested', { ask: Ask }),
  tagged('usage.updated', { usage: Usage }),
  tagged('ratelimit.updated', { rateLimit: RateLimit }),
  tagged('compaction.started', {}),
  tagged('compaction.completed', {}),
  tagged('turn.completed', { stopReason: Schema.String, usage: Usage }),
  tagged('session.warning', { kind: Schema.String, message: Schema.String }),
  tagged('session.error', {
    kind: Schema.Literals(['auth', 'ratelimit', 'crash', 'protocol']),
    message: Schema.String,
    retryable: Schema.Boolean,
  }),
  tagged('session.closed', {}),
  tagged('raw', { providerEvent: Schema.Unknown }),
])

export type Usage = typeof Usage.Type
export type RateLimit = typeof RateLimit.Type
export type ToolKind = typeof ToolKind.Type
export type AgentEvent = typeof AgentEvent.Type
export type AgentEventType = AgentEvent['type']
