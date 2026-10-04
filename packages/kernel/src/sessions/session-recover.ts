import type { SessionStatus } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { SessionError, StoreError } from '../errors.js'
import type { SessionDeps } from './session-deps.js'
import { settle } from './session-live.js'
import { listSessions } from './session-records.js'
import type { SessionManagerShape } from './session-shape.js'
import { move } from './session-status.js'
import type { Outcome } from './session-turns.js'
import type { Session } from './types.js'

// The statuses a previous process can leave a session in while it worked
const LEFT_RUNNING: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'provisioning',
  'running',
  'waiting_for_human',
  'paused_usage_limit',
])

const DAEMON_RESTART: Outcome = { status: 'interrupted', stopReason: 'daemon_restart', usage: null }

// A session attached in this process is alive and is left alone; the others have nothing attached any more
const isLeftBehind = (deps: SessionDeps, session: Session): boolean =>
  LEFT_RUNNING.has(session.status) && deps.live.get(session.id) === undefined

// Its turn is interrupted, its asks are cancelled, its worktree is unlocked and the session is stopped: resumable, as after any stop
const recoverOne = (
  deps: SessionDeps,
  session: Session,
): Effect.Effect<void, SessionError | StoreError> =>
  deps.live.exclusive(
    session.id,
    Effect.gen(function* recoversOne() {
      yield* settle(deps, session, DAEMON_RESTART)
      yield* move(deps, session.id, 'stop')
    }),
  )

export const makeRecover =
  (deps: SessionDeps): SessionManagerShape['recover'] =>
  () =>
    Effect.gen(function* recoversSessions() {
      const sessions = yield* listSessions(deps.sql)
      const left = sessions.filter((session) => isLeftBehind(deps, session))
      yield* Effect.forEach(left, (session) => recoverOne(deps, session), { discard: true })
      return left.map((session) => session.id)
    })
