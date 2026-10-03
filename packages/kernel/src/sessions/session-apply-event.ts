import type { AgentEvent, AgentEventType } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { SessionError, StoreError } from '../errors.js'
import type { Live } from './live-sessions.js'
import { announce } from './session-announce.js'
import { handleAsk } from './session-ask.js'
import type { SessionDeps } from './session-deps.js'
import {
  messageCompleted,
  rateLimited,
  toolEnded,
  toolStarted,
  turnCompleted,
  type Handled,
  type HandlerFailure,
} from './session-event-handlers.js'
import { failSession, reported } from './session-live.js'

type Handler<Type extends AgentEventType> = (
  deps: SessionDeps,
  live: Live,
  event: Handled<Type>,
) => Effect.Effect<void, HandlerFailure>
type Handlers = { readonly [Type in AgentEventType]: Handler<Type> }

// What the session manager does for each event of a provider; most are only told of, in the words of the catalogue, and those that need bookkeeping have a handler of their own
const HANDLERS: Handlers = {
  'turn.started': announce,
  'message.delta': announce,
  'message.completed': messageCompleted,
  'tool.started': toolStarted,
  'tool.completed': toolEnded,
  'tool.failed': toolEnded,
  'subagent.started': announce,
  'subagent.stopped': announce,
  'ask.requested': handleAsk,
  'usage.updated': announce,
  'ratelimit.updated': rateLimited,
  'compaction.started': announce,
  'compaction.completed': announce,
  'turn.completed': turnCompleted,
  'session.warning': announce,
  'session.error': failSession,
  'session.closed': announce,
  raw: announce,
}

interface Applying<Type extends AgentEventType> {
  readonly deps: SessionDeps
  readonly live: Live
  readonly event: Handled<Type>
}

// The lookup is generic in the type, which is what lets the compiler pair an event with its handler
const run = <Type extends AgentEventType>(
  type: Type,
  { deps, live, event }: Applying<Type>,
): Effect.Effect<void, HandlerFailure> => HANDLERS[type](deps, live, event)

// An event of the provider is applied on its own, never beside a command of the caller or another event
// Events that arrive once the session is let go are dropped; asks take the lock themselves, as they wait for a human
// Nothing is read or changed until the work runs, which is when the session is the kernel's to touch
const apply = (
  deps: SessionDeps,
  live: Live,
  event: AgentEvent,
): Effect.Effect<void, SessionError | StoreError> => {
  const work = Effect.suspend(() =>
    live.closed ? Effect.void : run(event.type, { deps, live, event }),
  )
  return event.type === 'ask.requested' ? work : deps.live.exclusive(live.session.id, work)
}

export const handleEvent = (
  deps: SessionDeps,
  live: Live,
  event: AgentEvent,
): Effect.Effect<void> =>
  apply(deps, live, event).pipe(reported({ sessionId: live.session.id, event: event.type }))
