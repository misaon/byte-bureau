import { Clock, Context, Effect, Layer, Option } from 'effect'
import type { HttpServerRequest } from 'effect/http'
import { ApiConfig } from './config.js'
import { problem, type ApiProblem } from './problems.js'
import { TokenBuckets, type Verdict } from './token-bucket.js'

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

// The verdict of the budget of the client at the time of the Clock of the request, so a test drives it with the TestClock instead of waiting
export const takeToken = (buckets: TokenBuckets, key: string): Effect.Effect<Verdict> =>
  Clock.currentTimeMillis.pipe(Effect.map((now) => buckets.take(key, now)))

// The 429 problem, which says when to retry
export const rateLimited = (retryAfterSec: number): ApiProblem<429> =>
  problem(429, 'rate_limited', `retry after ${retryAfterSec} s`)

// A token from the budget of the client, or the 429 problem that says when to retry
export const drawToken = (
  buckets: TokenBuckets,
  key: string,
): Effect.Effect<void, ApiProblem<429>> =>
  takeToken(buckets, key).pipe(
    Effect.flatMap((verdict) =>
      verdict.allowed ? Effect.void : Effect.fail(rateLimited(verdict.retryAfterSec)),
    ),
  )
