import type { KernelEvent, SessionStatus } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { SessionError, type StoreError } from '../errors.js'
import type { EventLogShape } from '../events/event-log.js'
import {
  erroredEvent,
  plainEvent,
  waitingEvent,
  type Failure,
  type PlainEvent,
} from './session-events.js'
import type { KernelInstance } from './live-sessions.js'
import { claimStatus, requireSession } from './session-records.js'
import { transition, type SessionEvent } from './state-machine.js'
import type { Session } from './types.js'

export type { Failure } from './session-events.js'

// What a change of status needs: the store that keeps it and the log that tells of it
export interface StatusDeps {
  readonly sql: SqlClient.SqlClient
  readonly log: EventLogShape
}

// A transition and the event of the catalogue that tells of it once the status has changed, and the kernel that takes the session over with it
interface Change {
  readonly event: SessionEvent
  readonly announce: (status: SessionStatus) => KernelEvent
  readonly owner?: KernelInstance | undefined
}

const invalid = (session: Session, event: SessionEvent): SessionError =>
  new SessionError({
    code: 'invalid_transition',
    reason: `cannot ${event} a ${session.status} session`,
  })

// Checked before anything is done for the event, so a refusal leaves nothing half done
export const ensureAllowed = (
  session: Session,
  event: SessionEvent,
): Effect.Effect<void, SessionError> =>
  transition(session.status, event) === null ? Effect.fail(invalid(session, event)) : Effect.void

// The session moves and then the move is announced
// A session that is no longer in the status the move was decided on does not move
const change = (
  deps: StatusDeps,
  sessionId: string,
  { event, announce, owner }: Change,
): Effect.Effect<Session, SessionError | StoreError> =>
  Effect.gen(function* changesStatus() {
    const session = yield* requireSession(deps.sql, sessionId)
    const next = transition(session.status, event)
    const moved = next === null ? undefined : yield* claimStatus(deps.sql, session, { next, owner })
    if (next === null || moved === undefined) {
      return yield* invalid(session, event)
    }
    yield* deps.log.publish({ ...announce(next), sessionId, projectId: session.projectId })
    return moved
  })

export const move = (
  deps: StatusDeps,
  sessionId: string,
  event: PlainEvent,
): Effect.Effect<Session, SessionError | StoreError> =>
  change(deps, sessionId, { event, announce: (status) => plainEvent(event, status) })

// The move of a kernel that takes the session over, which a resume or a prompt is: the row names it with the new status
export const moveAndClaim = (
  deps: StatusDeps & { readonly instance: KernelInstance },
  sessionId: string,
  event: PlainEvent,
): Effect.Effect<Session, SessionError | StoreError> =>
  change(deps, sessionId, {
    event,
    announce: (status) => plainEvent(event, status),
    owner: deps.instance,
  })

export const moveToWaiting = (
  deps: StatusDeps,
  sessionId: string,
  askId: string,
): Effect.Effect<Session, SessionError | StoreError> =>
  change(deps, sessionId, { event: 'ask', announce: (status) => waitingEvent(status, askId) })

export const moveToErrored = (
  deps: StatusDeps,
  sessionId: string,
  failure: Failure,
): Effect.Effect<Session, SessionError | StoreError> =>
  change(deps, sessionId, { event: 'crash', announce: (status) => erroredEvent(status, failure) })
