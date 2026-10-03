import { Schema } from 'effect'
import { RateLimit, ToolKind, Usage } from './agent-event.js'
import { Ask, AskAnswer } from './ask.js'
import { AnsweredVia, Id, SessionStatus, Timestamp, TurnStatus } from './common.js'
import { EventPayloadError } from './event-payload-error.js'

export { EventPayloadError } from './event-payload-error.js'

export const EventEnvelope = Schema.Struct({
  seq: Schema.Int,
  id: Id,
  ts: Timestamp,
  type: Schema.String,
  projectId: Schema.optionalKey(Id),
  sessionId: Schema.optionalKey(Id),
  turnId: Schema.optionalKey(Id),
  workItemId: Schema.optionalKey(Id),
  traceId: Schema.optionalKey(Schema.String),
  spanId: Schema.optionalKey(Schema.String),
  payload: Schema.Unknown,
})

const project = Schema.Struct({
  id: Id,
  name: Schema.String,
  path: Schema.String,
  defaultBranch: Schema.String,
})
const sessionRef = Schema.Struct({ status: SessionStatus })
const turnRef = Schema.Struct({ turnId: Id, index: Schema.Int, status: TurnStatus })
// Closed empty object: only {} decodes (Schema.Struct({}) would accept any non-null value)
const emptyPayload = Schema.Record(Schema.String, Schema.Never)

// Payload schema per kernel event type; the key is the wire `type`
export const KernelEventSchemas = {
  'project.registered': project,
  'project.updated': project,
  'project.removed': Schema.Struct({ id: Id }),
  'profile.added': Schema.Struct({ profileId: Id, providerId: Schema.String }),
  'profile.removed': Schema.Struct({ profileId: Id }),
  'profile.status': Schema.Struct({ profileId: Id, state: Schema.String }),
  'session.created': Schema.Struct({
    ...sessionRef.fields,
    title: Schema.String,
    employeeId: Schema.String,
    providerId: Schema.String,
  }),
  'session.provisioning': sessionRef,
  'session.ready': Schema.Struct({
    ...sessionRef.fields,
    model: Schema.optionalKey(Schema.String),
  }),
  'session.running': sessionRef,
  'session.waiting': Schema.Struct({ ...sessionRef.fields, askId: Id }),
  'session.paused': Schema.Struct({ ...sessionRef.fields, resetsAt: Schema.NullOr(Timestamp) }),
  'session.resumed': sessionRef,
  'session.stopped': sessionRef,
  'session.completed': sessionRef,
  'session.errored': Schema.Struct({
    ...sessionRef.fields,
    kind: Schema.Literals(['auth', 'ratelimit', 'crash', 'protocol']),
    message: Schema.String,
    retryable: Schema.Boolean,
  }),
  'session.warning': Schema.Struct({ kind: Schema.String, message: Schema.String }),
  'turn.started': turnRef,
  'turn.completed': Schema.Struct({ ...turnRef.fields, stopReason: Schema.String, usage: Usage }),
  'turn.interrupted': turnRef,
  'message.user': Schema.Struct({ text: Schema.String }),
  'message.assistant.completed': Schema.Struct({
    text: Schema.String,
    content: Schema.Array(Schema.Unknown),
  }),
  'tool.started': Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    kind: ToolKind,
    input: Schema.Unknown,
  }),
  'tool.completed': Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    outputSummary: Schema.String,
    bytes: Schema.Int,
  }),
  'tool.failed': Schema.Struct({ id: Schema.String, name: Schema.String, error: Schema.String }),
  'subagent.started': Schema.Struct({ id: Schema.String, name: Schema.String }),
  'subagent.stopped': Schema.Struct({ id: Schema.String, name: Schema.String }),
  'ask.requested': Schema.Struct({ ask: Ask }),
  'ask.answered': Schema.Struct({ askId: Id, answer: AskAnswer, answeredVia: AnsweredVia }),
  'ask.expired': Schema.Struct({ askId: Id, fallback: Schema.String }),
  'ask.cancelled': Schema.Struct({ askId: Id }),
  'usage.updated': Schema.Struct({ usage: Usage }),
  'ratelimit.updated': Schema.Struct({ profileId: Schema.NullOr(Id), rateLimit: RateLimit }),
  'compaction.started': emptyPayload,
  'compaction.completed': emptyPayload,
  'workspace.provisioned': Schema.Struct({
    path: Schema.String,
    branch: Schema.String,
    baseRef: Schema.String,
    runtimeId: Schema.String,
  }),
  'workspace.destroyed': Schema.Struct({ path: Schema.String }),
  'workspace.retained': Schema.Struct({ path: Schema.String, reason: Schema.String }),
  'plugin.loaded': Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    ports: Schema.Array(Schema.String),
  }),
  'plugin.failed': Schema.Struct({ name: Schema.String, reason: Schema.String }),
  'message.assistant.delta': Schema.Struct({
    kind: Schema.Literals(['text', 'thinking']),
    text: Schema.String,
  }),
  'tool.progress': Schema.Struct({ id: Schema.String, text: Schema.String }),
  heartbeat: Schema.Struct({ at: Timestamp }),
} as const

export const EPHEMERAL_EVENT_TYPES = [
  'message.assistant.delta',
  'tool.progress',
  'heartbeat',
] as const

const isKernelEventType = (type: string): type is KernelEventType =>
  Object.hasOwn(KernelEventSchemas, type)

export const KERNEL_EVENT_TYPES: readonly KernelEventType[] = Object.keys(
  KernelEventSchemas,
).filter((key) => isKernelEventType(key))

export type KernelEventType = keyof typeof KernelEventSchemas
export type KernelEventPayload<EventType extends KernelEventType> =
  (typeof KernelEventSchemas)[EventType]['Type']
export type EventEnvelope = typeof EventEnvelope.Type

export interface KernelEvent<EventType extends KernelEventType = KernelEventType> {
  readonly type: EventType
  readonly payload: KernelEventPayload<EventType>
  readonly projectId?: string | undefined
  readonly sessionId?: string | undefined
  readonly turnId?: string | undefined
}

/** True for live-only event types: fanned out to subscribers, never persisted */
export function isEphemeral(type: string): boolean {
  return (EPHEMERAL_EVENT_TYPES as readonly string[]).includes(type)
}

// The same contract as the published JSON Schema: every payload is a closed object
const STRICT = { errors: 'all', onExcessProperty: 'error' } as const

/**
 * Decodes the payload of an event against the schema of its type.
 * A type narrowed to a literal gives the typed payload; any other string is checked at run time.
 * Throws an EventPayloadError when the type is not in the catalogue or the payload does not fit its schema.
 * A field the schema does not know is refused, as the published JSON Schema refuses it; a payload grows with a new schema version.
 */
export function decodeEventPayload<EventType extends KernelEventType>(
  type: EventType,
  payload: unknown,
): KernelEventPayload<EventType>
/** Decodes the payload of an event whose type is only known as a string. */
export function decodeEventPayload(type: string, payload: unknown): unknown
export function decodeEventPayload(type: string, payload: unknown): unknown {
  if (!isKernelEventType(type)) {
    throw new EventPayloadError(type, `unknown kernel event type: ${type}`)
  }
  try {
    return Schema.decodeUnknownSync(KernelEventSchemas[type])(payload, STRICT)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new EventPayloadError(type, `the payload of ${type} does not fit its schema: ${reason}`, {
      cause: error,
    })
  }
}
