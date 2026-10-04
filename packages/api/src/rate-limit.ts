import { Effect, Layer } from 'effect'
import { HttpServerRequest } from 'effect/http'
import { HttpApiMiddleware } from 'effect/http-api'
import { clientKey, drawToken, MutationBuckets } from './mutation-buckets.js'
import { Problem429 } from './problems.js'

// Mutations are rate limited per client; a client that runs dry gets a 429 problem that says when to retry
export class MutationLimit extends HttpApiMiddleware.Service<MutationLimit>()(
  'bb/api/MutationLimit',
  { error: Problem429 },
) {}

export const MutationLimitLive: Layer.Layer<MutationLimit, never, MutationBuckets> = Layer.effect(
  MutationLimit,
  Effect.gen(function* makeMutationLimit() {
    const buckets = yield* MutationBuckets
    return (httpEffect) =>
      Effect.gen(function* limitsMutation() {
        const request = yield* HttpServerRequest.HttpServerRequest
        yield* drawToken(buckets, clientKey(request))
        return yield* httpEffect
      })
  }),
)
