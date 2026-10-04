import { Effect } from 'effect'
import type { EventLogShape } from '../events/event-log.js'
import { logger } from './session-logger.js'

// The kind of the warning a start leaves on a session it could not recover
const RECOVERY_FAILED = 'recovery_failed'

export interface NotRecovered {
  readonly sessionId: string
  readonly projectId?: string | undefined
  // What the log says, and why
  readonly message: string
  readonly reason: string
}

const isRecoveryWarning = (payload: unknown): boolean =>
  typeof payload === 'object' &&
  payload !== null &&
  Reflect.get(payload, 'kind') === RECOVERY_FAILED

// A store that cannot say counts as never having told it
const alreadyTold = (log: EventLogShape, sessionId: string): Effect.Effect<boolean> =>
  log.read({ sessionId, types: ['session.warning'] }, { from: 0 }).pipe(
    Effect.map((told) => told.some((event) => isRecoveryWarning(event.payload))),
    Effect.orElseSucceed(() => false),
  )

/**
 * A session the start cannot recover is told once: a warning in the log, and a session.warning on the session for its
 * clients. A later start finds that warning and tells the same at debug level, instead of a warning at every start.
 */
export const tellNotRecovered = (
  log: EventLogShape,
  { sessionId, projectId, message, reason }: NotRecovered,
): Effect.Effect<void> =>
  Effect.gen(function* tellsOnce() {
    const properties = { sessionId, reason }
    if (yield* alreadyTold(log, sessionId)) {
      logger.debug(message, properties)
      return
    }
    logger.warn(message, properties)
    const payload = { kind: RECOVERY_FAILED, message: `${message}: ${reason}` }
    yield* Effect.ignore(log.publish({ type: 'session.warning', sessionId, projectId, payload }))
  })
