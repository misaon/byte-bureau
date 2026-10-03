import type { Ask, AskRecord } from '@bytebureau/protocol'
import { Cause, Effect, Fiber, Latch, type Scope } from 'effect'
import type { StoreError } from '../errors.js'
import { kernelLogger } from '../logging/logging.js'
import { buildAsk, timeoutMs, unrecommendedQuestions, type OpenAskInput } from './ask-build.js'
import { announceRequest } from './ask-events.js'
import { insertAsk } from './ask-records.js'
import { expire, withdrawAsk, type AskDeps } from './ask-settle.js'
import { park } from './ask-waiters.js'

// The timers belong to the scope of the layer, so they outlive the fiber of whoever opens an ask
export interface OpenDeps extends AskDeps {
  readonly scope: Scope.Scope
}

const logger = kernelLogger(['bb', 'asks'])

// The title and the input of the tool stay out of the log: either can carry a credential
const warnWithoutRecommendation = (ask: Ask): void => {
  if (ask.recommendationSource === 'none') {
    logger.warn('no recommendation available', {
      sessionId: ask.sessionId,
      kind: ask.kind,
      ...(ask.toolCall === undefined ? {} : { toolName: ask.toolCall.name }),
      questions: unrecommendedQuestions(ask),
    })
  }
}

// An expiry that fails leaves the ask pending, so the failure is told and never swallowed
const reportExpiry =
  (ask: Ask) =>
  (error: StoreError): Effect.Effect<void> =>
    Effect.sync(() => {
      logger.error('an ask could not be expired', {
        askId: ask.id,
        sessionId: ask.sessionId,
        cause: error.cause,
      })
    })

// An ask that waits has no timer; any other one is expired by its policy once the timeout is over, but not before its request is announced
// The result stops the timer; an ask that waits has none to stop
export const armTimer = (
  deps: OpenDeps,
  ask: Ask,
  announced: Latch.Latch,
): Effect.Effect<Effect.Effect<void>> => {
  const delay = timeoutMs(ask.policy)
  if (delay === null) {
    return Effect.succeed(Effect.void)
  }
  const expiry = Effect.sleep(delay).pipe(
    Effect.andThen(announced.await),
    Effect.andThen(expire(deps, ask)),
  )
  const guarded = expiry.pipe(Effect.catchTag('StoreError', reportExpiry(ask)))
  return Effect.map(Effect.forkIn(guarded, deps.scope), (timer) => Fiber.interrupt(timer))
}

// Taking back an ask that was never announced is best effort; a failure of it is told, the caller still gets the first one
const withdraw = (deps: OpenDeps, ask: Ask, disarm: Effect.Effect<void>): Effect.Effect<void> =>
  Effect.andThen(disarm, withdrawAsk(deps, ask.id)).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        logger.error('an ask that was not announced could not be withdrawn', {
          askId: ask.id,
          sessionId: ask.sessionId,
          cause: Cause.pretty(cause),
        })
      }),
    ),
  )

// The timer is armed before the request is announced; when the announcement fails or dies there is no pending ask left behind
// The ask is cancelled and its timer stopped, and the caller gets the failure, or the defect, of the announcement
export const announce = (
  deps: OpenDeps,
  ask: Ask,
  disarm: Effect.Effect<void>,
): Effect.Effect<void, StoreError> =>
  Effect.suspend(() => announceRequest(deps.log, ask)).pipe(
    Effect.onError(() => withdraw(deps, ask, disarm)),
  )

// The waiter is parked before anything is announced, so an answer that comes at once has someone to reach
// Nothing may interrupt the steps from the insert on: an ask is announced with its timer armed, or it is not left behind
export const openAsk = (
  deps: OpenDeps,
  input: OpenAskInput,
): Effect.Effect<AskRecord, StoreError> =>
  Effect.gen(function* opensAsk() {
    const ask = buildAsk(input)
    warnWithoutRecommendation(ask)
    yield* insertAsk(deps.sql, ask)
    yield* park(deps.waiters, ask.id)
    const announced = yield* Latch.make()
    const disarm = yield* armTimer(deps, ask, announced)
    yield* announce(deps, ask, disarm)
    yield* announced.open
    return { ...ask, answer: null, answeredAt: null, answeredVia: null }
  }).pipe(Effect.uninterruptible)
