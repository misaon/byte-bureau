import { Clock, Context, Effect, Layer, Option } from 'effect'
import type { HttpServerRequest } from 'effect/http'
import { ApiConfig } from './config.js'
import { problem, type ApiProblem } from './problems.js'
import { TokenBuckets } from './token-bucket.js'

// The mutation budgets of the clients: one per client, whichever door it comes through (the REST API or the RPC socket)
export class MutationBuckets extends Context.Service<MutationBuckets, TokenBuckets>()(
  'bb/api/MutationBuckets',
) {}

export const MutationBucketsLive: Layer.Layer<MutationBuckets, never, ApiConfig> = Layer.effect(
  MutationBuckets,
  Effect.gen(function* makeMutationBuckets() {
    const { mutationLimit } = yield* ApiConfig
    return new TokenBuckets(mutationLimit)
  }),
)

// A client is known by the address it calls from
export const clientKey = (request: HttpServerRequest.HttpServerRequest): string =>
  Option.getOrElse(request.remoteAddress, () => 'local')

// A token from the budget of the client, or the 429 problem that says when to retry
// The time is the Clock's of the request, so a test drives the budget with the TestClock instead of waiting
export const drawToken = (
  buckets: TokenBuckets,
  key: string,
): Effect.Effect<void, ApiProblem<429>> =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => {
      const verdict = buckets.take(key, now)
      return verdict.allowed
        ? Effect.void
        : Effect.fail(problem(429, 'rate_limited', `retry after ${verdict.retryAfterSec} s`))
    }),
  )
