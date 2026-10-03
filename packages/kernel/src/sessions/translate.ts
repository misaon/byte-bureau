import type { AgentEvent, AgentEventType, KernelEvent } from '@bytebureau/protocol'

export interface TurnRef {
  readonly turnId: string
  readonly index: number
}

// What the kernel knows about the session around an event: how a tool call is named and which profile it runs under
export interface Lookups {
  readonly toolName: (toolId: string) => string
  readonly profileId: string | null
}

// What the events of a turn are told: the turn that is running, if any
interface Telling extends Lookups {
  readonly turn: TurnRef | null
}

type OfType<Type extends AgentEventType> = Extract<AgentEvent, { readonly type: Type }>
type Translator<Type extends AgentEventType> = (
  event: OfType<Type>,
  telling: Telling,
) => KernelEvent | null
type Translators = { readonly [Type in AgentEventType]: Translator<Type> }

const nothing = (): null => null

// The kernel events of the catalogue by the type of the provider event; null leaves an event out
const TRANSLATORS: Translators = {
  'turn.started': (_event, { turn }) =>
    turn === null ? null : { type: 'turn.started', payload: { ...turn, status: 'running' } },
  'message.delta': (event) => ({
    type: 'message.assistant.delta',
    payload: { kind: event.kind, text: event.text },
  }),
  'message.completed': (event) =>
    event.role === 'assistant'
      ? {
          type: 'message.assistant.completed',
          payload: { text: event.text, content: event.content },
        }
      : null,
  'tool.started': (event) => ({
    type: 'tool.started',
    payload: { id: event.id, name: event.name, kind: event.kind, input: event.input },
  }),
  'tool.completed': (event, { toolName }) => ({
    type: 'tool.completed',
    payload: {
      id: event.id,
      name: toolName(event.id),
      outputSummary: event.outputSummary,
      bytes: event.bytes,
    },
  }),
  'tool.failed': (event, { toolName }) => ({
    type: 'tool.failed',
    payload: { id: event.id, name: toolName(event.id), error: event.error },
  }),
  'subagent.started': (event) => ({
    type: 'subagent.started',
    payload: { id: event.id, name: event.name },
  }),
  'subagent.stopped': (event) => ({
    type: 'subagent.stopped',
    payload: { id: event.id, name: event.name },
  }),
  'ask.requested': nothing,
  'usage.updated': (event) => ({ type: 'usage.updated', payload: { usage: event.usage } }),
  'ratelimit.updated': (event, { profileId }) => ({
    type: 'ratelimit.updated',
    payload: { profileId, rateLimit: event.rateLimit },
  }),
  'compaction.started': () => ({ type: 'compaction.started', payload: {} }),
  'compaction.completed': () => ({ type: 'compaction.completed', payload: {} }),
  'turn.completed': nothing,
  'session.warning': (event) => ({
    type: 'session.warning',
    payload: { kind: event.kind, message: event.message },
  }),
  'session.error': nothing,
  'session.closed': nothing,
  raw: nothing,
}

// The lookup is generic in the type, which is what lets the compiler pair an event with its translator
const apply = <Type extends AgentEventType>(
  type: Type,
  event: OfType<Type>,
  telling: Telling,
): KernelEvent | null => TRANSLATORS[type](event, telling)

const UNKNOWN: Lookups = { toolName: () => '', profileId: null }

// Pure mapping provider → kernel catalogue
// Asks, the end of a turn and errors carry bookkeeping and are handled by the session manager
// A finished tool call carries the name that the caller noted when it started, empty when unknown
export function translate(
  event: AgentEvent,
  turn: TurnRef | null,
  lookups: Lookups = UNKNOWN,
): KernelEvent | null {
  return apply(event.type, event, { ...lookups, turn })
}
