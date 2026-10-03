import { Effect } from 'effect'
import { constVoid } from 'effect/Function'
import { SessionError } from '../errors.js'
import { reasonOf } from '../plugins/reason.js'
import type { Live } from './live-sessions.js'
import type { SessionDeps } from './session-deps.js'
import { cancelAsks, interruptAgent, reported, withinLimit } from './session-live.js'
import { logger } from './session-logger.js'
import type { SessionManagerShape } from './session-shape.js'

// The turn is marked before anything else is done, so a question it asks from then on is known to be moot
// Only an agent that can be interrupted stops asking; the questions of one that cannot still count
const markInterrupted = (live: Live): Effect.Effect<void> =>
  Effect.sync(() => {
    live.interrupted = live.interruptible && live.turn !== null ? live.turn.turnId : null
  })

// An agent that did not take the interruption goes on with its turn, so what it asks next counts again
const interruptOrUnmark = (live: Live): Effect.Effect<void> => {
  const interrupting = Effect.tryPromise({
    try: async () => {
      await interruptAgent(live)
    },
    catch: reasonOf,
  })
  return Effect.match(withinLimit(interrupting), {
    onFailure: (failure) => {
      live.interrupted = null
      logger.warn('interrupting the agent failed', {
        sessionId: live.session.id,
        reason: reasonOf(failure),
      })
    },
    onSuccess: constVoid,
  })
}

// The provider acknowledges an interruption by ending the turn, which is when the session is ready again
// A question that waits for an answer is not answered by an interrupted agent, so it is cancelled, and so is one it asks meanwhile
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
      const cancelling = reported({ sessionId, event: 'interrupt' })(cancelAsks(deps, sessionId))
      return markInterrupted(live).pipe(
        Effect.andThen(cancelling),
        Effect.andThen(interruptOrUnmark(live)),
      )
    })
