import { Effect, Result } from 'effect'
import type { SessionError, StoreError } from '../errors.js'
import type { SessionDeps } from './session-deps.js'
import { settle } from './session-live.js'
import { logger } from './session-logger.js'
import { isLeftBehind, RECOVERABLE } from './session-owner.js'
import { listOwned, loadOwned, type OwnedRead, type OwnedSession } from './session-records.js'
import type { SessionManagerShape } from './session-shape.js'
import { move } from './session-status.js'
import type { Outcome } from './session-turns.js'

const DAEMON_RESTART: Outcome = { status: 'interrupted', stopReason: 'daemon_restart', usage: null }

// A row that cannot be read is told and passed over; the next start finds it again
const readable = ({ id, owned }: OwnedRead): readonly OwnedSession[] => {
  if (Result.isSuccess(owned)) {
    return [owned.success]
  }
  logger.warn('a session left at work cannot be read and is not recovered', {
    sessionId: id,
    reason: owned.failure.message,
  })
  return []
}

// The decision is taken again under the lock of the session, on its row as it stands now: one that moved or found an owner meanwhile is left alone
// Its turn is interrupted, its asks are cancelled, its worktree is unlocked and the session is stopped: resumable, as after any stop
const recoverOne = (
  deps: SessionDeps,
  sessionId: string,
): Effect.Effect<boolean, SessionError | StoreError> =>
  deps.live.exclusive(
    sessionId,
    Effect.gen(function* recoversOne() {
      const current = yield* loadOwned(deps.sql, sessionId)
      if (current === undefined || !isLeftBehind(deps, current)) {
        return false
      }
      yield* settle(deps, current.session, DAEMON_RESTART)
      yield* move(deps, sessionId, 'stop')
      return true
    }),
  )

// A session that cannot be recovered is told and passed over, so the others still are
const attemptOne = (deps: SessionDeps, sessionId: string): Effect.Effect<readonly string[]> =>
  Effect.match(recoverOne(deps, sessionId), {
    onFailure: (failure) => {
      logger.warn('a session left at work could not be recovered', {
        sessionId,
        reason: failure.message,
      })
      return []
    },
    onSuccess: (stopped) => (stopped ? [sessionId] : []),
  })

// Only the sessions in a status of work are read; the ids of those that were stopped are given back
export const makeRecover =
  (deps: SessionDeps): SessionManagerShape['recover'] =>
  () =>
    Effect.gen(function* recoversSessions() {
      const reads = yield* listOwned(deps.sql, RECOVERABLE)
      const left = reads
        .flatMap((read) => readable(read))
        .filter((owned) => isLeftBehind(deps, owned))
      const stopped = yield* Effect.all(left.map(({ session }) => attemptOne(deps, session.id)))
      return stopped.flat()
    })
