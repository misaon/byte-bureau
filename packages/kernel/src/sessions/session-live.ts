import { Cause, Effect, Exit, Fiber, Scope } from 'effect'
import { constVoid } from 'effect/Function'
import type { StoreError } from '../errors.js'
import { reasonOf } from '../plugins/reason.js'
import type { Live } from './live-sessions.js'
import { logger, type SessionDeps } from './session-deps.js'
import { saveExternalRef } from './session-records.js'
import { moveToErrored, type Failure } from './session-status.js'
import { finishTurn, type Outcome, type Owner } from './session-turns.js'

// Work nobody waits for has no caller to tell about a failure, so the failure, or the defect, is logged and that is all
export const reported =
  (context: Readonly<Record<string, unknown>>) =>
  (work: Effect.Effect<unknown, unknown>): Effect.Effect<void> =>
    Effect.matchCause(work, {
      onFailure: (cause) => {
        logger.error('session work failed', { ...context, cause: Cause.pretty(cause) })
      },
      onSuccess: constVoid,
    })

const closeAgent = async (live: Live): Promise<void> => {
  await live.agent.close()
}

export const interruptAgent = async (live: Live): Promise<void> => {
  await live.agent.interrupt()
}

// A provider that does not answer a call within this time is given up on, so it cannot hold a session for ever
// The prompt is the exception: it may be answered only when the turn is over
const CALL_LIMIT = '10 seconds'

export const withinLimit = <Value, Problem>(
  call: Effect.Effect<Value, Problem>,
): Effect.Effect<Value, Problem | Cause.TimeoutError> => Effect.timeout(call, CALL_LIMIT)

// A call into the provider that must not fail the caller: the failure is logged and that is all
export const attempt = (
  what: string,
  sessionId: string,
  call: () => Promise<void>,
): Effect.Effect<void> =>
  withinLimit(Effect.tryPromise({ try: call, catch: reasonOf })).pipe(
    Effect.match({
      onFailure: (failure) => {
        logger.warn(`${what} failed`, { sessionId, reason: reasonOf(failure) })
      },
      onSuccess: constVoid,
    }),
  )

// The same for a call on the provider session of a live session
export const bestEffort = (
  what: string,
  live: Live,
  call: (live: Live) => Promise<void>,
): Effect.Effect<void> =>
  attempt(what, live.session.id, async () => {
    await call(live)
  })

// The kernel lets the provider session go; nothing it still says counts afterwards
// Closing comes first so the provider can end gracefully, aborting its signal is the hard stop after it
export const dispose = (deps: SessionDeps, live: Live): Effect.Effect<void> =>
  Effect.suspend(() => {
    live.closed = true
    deps.live.remove(live)
    return bestEffort('closing the agent', live, closeAgent).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          live.controller.abort()
        }),
      ),
    )
  })

// A pump that does not end within this time is given up on: once its provider session is let go, nothing it says counts
// An events stream that is an async generator ends only when the read in progress is answered, so a provider that does not end its events holds its pump
const PUMP_LIMIT = '3 seconds'

// The pump ends by itself once the provider closes; one that does not is interrupted, and waited for only so long
export const interruptPump = (live: Live): Effect.Effect<void> =>
  live.pump === undefined
    ? Effect.void
    : Effect.ignore(Effect.timeout(Fiber.interrupt(live.pump), PUMP_LIMIT))

// The fibers of the sessions end with their scope, which is closed on a fiber of its own: a pump that does not end cannot hold the caller for more than a while
export const releaseFibers = (scope: Scope.Closeable): Effect.Effect<void> =>
  Effect.forkDetach(Scope.close(scope, Exit.void)).pipe(
    Effect.flatMap((closing) => Effect.timeout(Fiber.await(closing), PUMP_LIMIT)),
    Effect.ignore,
  )

// The reference the provider gives its session is what a later resume attaches to
export const rememberRef = (deps: SessionDeps, live: Live): Effect.Effect<void, StoreError> => {
  const { externalRef } = live.agent
  return externalRef === null
    ? Effect.void
    : saveExternalRef(deps.sql, live.session.id, externalRef)
}

// Nobody can answer an ask of a session that is ending
export const cancelAsks = (deps: SessionDeps, sessionId: string): Effect.Effect<void, StoreError> =>
  Effect.flatMap(deps.asks.pending(sessionId), (pending) =>
    Effect.forEach(pending, (ask) => deps.asks.cancel(ask.id), { discard: true }),
  )

// What ending a session leaves behind: its running turn ends, its asks are cancelled and its worktree can be removed again
export const settle = (
  deps: SessionDeps,
  session: Owner,
  outcome: Outcome,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* settlesSession() {
    yield* finishTurn(deps, session, outcome)
    yield* cancelAsks(deps, session.id)
    yield* deps.workspaces.unlock(session.id)
  })

// The provider failed: the turn is errored, the session crashes and the provider session is let go
// A session that cannot crash from where it stands (it was stopped meanwhile) is left as it is
export const failSession = (
  deps: SessionDeps,
  live: Live,
  failure: Failure,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* failsSession() {
    yield* settle(deps, live.session, { status: 'errored', stopReason: failure.kind, usage: null })
    live.turn = null
    yield* dispose(deps, live)
    yield* moveToErrored(deps, live.session.id, failure).pipe(
      Effect.catchTag('SessionError', (refusal) =>
        Effect.sync(() => {
          logger.warn('session not marked errored', {
            sessionId: live.session.id,
            reason: refusal.reason,
          })
        }),
      ),
    )
  })
