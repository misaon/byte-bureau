import { Effect, Layer, Option } from 'effect'
import { HttpServerRequest } from 'effect/http'
import { HttpApiMiddleware } from 'effect/http-api'
import { ApiConfig } from './config.js'
import { Problem429, problem } from './problems.js'
import { TokenBuckets } from './token-bucket.js'

// Mutations are rate limited per client; a client that runs dry gets a 429 problem that says when to retry
export class MutationLimit extends HttpApiMiddleware.Service<MutationLimit>()(
  'bb/api/MutationLimit',
  { error: Problem429 },
) {}

const clientKey = (request: HttpServerRequest.HttpServerRequest): string =>
  Option.getOrElse(request.remoteAddress, () => 'local')

export const MutationLimitLive: Layer.Layer<MutationLimit, never, ApiConfig> = Layer.effect(
  MutationLimit,
  Effect.gen(function* makeMutationLimit() {
    const { mutationLimit } = yield* ApiConfig
    const buckets = new TokenBuckets({ ...mutationLimit, now: Date.now })
    return (httpEffect) =>
      Effect.gen(function* limitsMutation() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const verdict = buckets.take(clientKey(request))
        if (!verdict.allowed) {
          return yield* Effect.fail(
            problem(429, 'rate_limited', `retry after ${verdict.retryAfterSec} s`),
          )
        }
        return yield* httpEffect
      })
  }),
)
