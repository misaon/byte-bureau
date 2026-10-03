import type { Ask, AskRecord } from '@bytebureau/protocol'
import { Effect, type Scope } from 'effect'
import type { StoreError } from '../errors.js'
import { kernelLogger } from '../logging/logging.js'
import { buildAsk, timeoutMs, type OpenAskInput } from './ask-build.js'
import { announceRequest } from './ask-events.js'
import { insertAsk } from './ask-records.js'
import { expire, type AskDeps } from './ask-settle.js'
import { park } from './ask-waiters.js'

// The timers belong to the scope of the layer, so they outlive the fiber of whoever opens an ask
export interface OpenDeps extends AskDeps {
  readonly scope: Scope.Scope
}

const logger = kernelLogger(['bb', 'asks'])

const warnWithoutRecommendation = (ask: Ask): void => {
  if (ask.recommendationSource === 'none') {
    logger.warn('no recommendation available', { sessionId: ask.sessionId, title: ask.title })
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

// An ask that waits has no timer; any other one is expired by its policy once the timeout is over
const armTimer = (deps: OpenDeps, ask: Ask): Effect.Effect<void> => {
  const delay = timeoutMs(ask.policy)
  if (delay === null) {
    return Effect.void
  }
  const expiry = Effect.andThen(Effect.sleep(delay), expire(deps, ask))
  const guarded = expiry.pipe(Effect.catchTag('StoreError', reportExpiry(ask)))
  return Effect.asVoid(Effect.forkIn(guarded, deps.scope))
}

// The waiter is parked before the request is announced, so an answer that comes at once has someone to reach
export const openAsk = (
  deps: OpenDeps,
  input: OpenAskInput,
): Effect.Effect<AskRecord, StoreError> =>
  Effect.gen(function* opensAsk() {
    const ask = buildAsk(input)
    warnWithoutRecommendation(ask)
    yield* insertAsk(deps.sql, ask)
    yield* park(deps.waiters, ask.id)
    yield* announceRequest(deps.log, ask)
    yield* armTimer(deps, ask)
    return { ...ask, answer: null, answeredAt: null, answeredVia: null }
  })
