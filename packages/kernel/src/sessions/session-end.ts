import { Effect } from 'effect'
import { SessionError, type StoreError } from '../errors.js'
import type { Live } from './live-sessions.js'
import type { SessionDeps } from './session-deps.js'
import {
  bestEffort,
  cancelAsks,
  dispose,
  interruptAgent,
  interruptPump,
  rememberRef,
  reported,
  settle,
} from './session-live.js'
import { requireSession } from './session-records.js'
import type { SessionManagerShape } from './session-shape.js'
import { ensureAllowed, move } from './session-status.js'
import type { Outcome } from './session-turns.js'

// A turn that the caller stopped is interrupted, whatever the provider would have said about it
const STOPPED: Outcome = { status: 'interrupted', stopReason: 'stopped', usage: null }

// The provider session is let go for good: its reference is kept for a resume, nothing it says counts any more
const release = (deps: SessionDeps, live: Live): Effect.Effect<void, StoreError> =>
  Effect.gen(function* releasesLive() {
    yield* rememberRef(deps, live)
    yield* dispose(deps, live)
    yield* interruptPump(live)
  })

// The provider acknowledges an interruption by ending the turn, which is when the session is ready again
// A question that waits for an answer is not answered by an interrupted agent, so it is cancelled
export const makeInterrupt =
  (deps: SessionDeps): SessionManagerShape['interrupt'] =>
  (sessionId) =>
    Effect.suspend(() => {
      const live = deps.live.get(sessionId)
      if (live === undefined) {
        return Effect.fail(
          new SessionError({ code: 'not_found', reason: `session ${sessionId} is not running` }),
        )
      }
      return reported({ sessionId, event: 'interrupt' })(cancelAsks(deps, sessionId)).pipe(
        Effect.andThen(bestEffort('interrupting the agent', live, interruptAgent)),
      )
    })

// The agent is interrupted before it is closed, so it can end its turn; the worktree stays, and so does the record of the work
const stopLive = (deps: SessionDeps, live: Live): Effect.Effect<void, StoreError> =>
  Effect.gen(function* stopsLive() {
    yield* bestEffort('interrupting the agent', live, interruptAgent)
    yield* settle(deps, live.session, STOPPED)
    live.turn = null
    yield* release(deps, live)
  })

export const makeStop =
  (deps: SessionDeps): SessionManagerShape['stop'] =>
  (sessionId) =>
    deps.live.exclusive(
      sessionId,
      Effect.gen(function* stopsSession() {
        const session = yield* requireSession(deps.sql, sessionId)
        yield* ensureAllowed(session, 'stop')
        const live = deps.live.get(sessionId)
        yield* live === undefined ? settle(deps, session, STOPPED) : stopLive(deps, live)
        yield* move(deps, sessionId, 'stop')
      }),
    )

export const makeComplete =
  (deps: SessionDeps): SessionManagerShape['complete'] =>
  (sessionId) =>
    deps.live.exclusive(
      sessionId,
      Effect.gen(function* completesSession() {
        const session = yield* requireSession(deps.sql, sessionId)
        yield* ensureAllowed(session, 'complete')
        const live = deps.live.get(sessionId)
        if (live !== undefined) {
          yield* release(deps, live)
        }
        yield* deps.workspaces.unlock(sessionId)
        yield* move(deps, sessionId, 'complete')
      }),
    )

export const makeResume =
  (deps: SessionDeps): SessionManagerShape['resume'] =>
  (sessionId) =>
    deps.live.exclusive(sessionId, move(deps, sessionId, 'resume'))
