import { Effect } from 'effect'
import type { StoreError } from '../errors.js'
import type { Live } from './live-sessions.js'
import type { SessionDeps } from './session-deps.js'
import { storedEnvironment } from './session-environment.js'
import {
  bestEffort,
  cancelAsks,
  dispose,
  interruptAgent,
  interruptPump,
  rememberRef,
  settle,
} from './session-live.js'
import { claimOwner, requireSession } from './session-records.js'
import type { SessionManagerShape } from './session-shape.js'
import { ensureAllowed, move } from './session-status.js'
import type { Outcome } from './session-turns.js'

// The commands that end or pause what an agent does, in one place for the manager
export { makeInterrupt } from './session-interrupt.js'
export { makeRecover } from './session-recover.js'

// A turn that the caller stopped is interrupted, whatever the provider would have said about it
const STOPPED: Outcome = { status: 'interrupted', stopReason: 'stopped', usage: null }

// The provider session is let go for good: its reference is kept for a resume, nothing it says counts any more
const release = (deps: SessionDeps, live: Live): Effect.Effect<void, StoreError> =>
  Effect.gen(function* releasesLive() {
    yield* rememberRef(deps, live)
    yield* dispose(deps, live)
    yield* interruptPump(live)
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
        deps.live.forget(sessionId)
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
        yield* cancelAsks(deps, sessionId)
        if (live !== undefined) {
          yield* release(deps, live)
        }
        yield* deps.workspaces.unlock(sessionId)
        yield* move(deps, sessionId, 'complete')
        deps.live.forget(sessionId)
      }),
    )

// The environment is read before the session moves, so a configuration that cannot be read leaves the session stopped
// The kernel that resumes the session owns it from then on
export const makeResume =
  (deps: SessionDeps): SessionManagerShape['resume'] =>
  (sessionId) =>
    deps.live.exclusive(
      sessionId,
      Effect.gen(function* resumesSession() {
        const stopped = yield* requireSession(deps.sql, sessionId)
        yield* ensureAllowed(stopped, 'resume')
        const environment = yield* storedEnvironment(deps, stopped)
        yield* claimOwner(deps.sql, sessionId, deps.instance)
        const session = yield* move(deps, sessionId, 'resume')
        deps.live.setEnvironment(session.id, environment)
        return session
      }),
    )
