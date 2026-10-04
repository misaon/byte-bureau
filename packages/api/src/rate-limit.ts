import { Effect, Layer, Schema } from 'effect'
import { HttpServerRequest } from 'effect/http'
import { HttpApiMiddleware, HttpApiSchema } from 'effect/http-api'
import { clientKey, MutationBuckets, rateLimited, takeToken } from './mutation-buckets.js'
import { Problem413, Problem429 } from './problems.js'

// The 429 problem with the seconds to wait in Retry-After as well, which a client or a proxy reads without the body
const Limited429 = HttpApiSchema.WithHeaders(Problem429, {
  'retry-after': Schema.String.annotate({ description: 'Seconds to wait before a retry' }),
})

// Mutations are rate limited per client; a client that runs dry gets a 429 problem that says when to retry
// Every mutation may also meet the 413 of the body limit, which answers before any route: declared here, so the document lists it
export class MutationLimit extends HttpApiMiddleware.Service<MutationLimit>()(
  'bb/api/MutationLimit',
  { error: [Limited429, Problem413] },
) {}

const limited = (seconds: number): typeof Limited429.Type =>
  HttpApiSchema.withHeaders({
    body: rateLimited(seconds),
    headers: { 'retry-after': String(seconds) },
  })

export const MutationLimitLive: Layer.Layer<MutationLimit, never, MutationBuckets> = Layer.effect(
  MutationLimit,
  Effect.gen(function* makeMutationLimit() {
    const buckets = yield* MutationBuckets
    return (httpEffect) =>
      Effect.gen(function* limitsMutation() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const verdict = yield* takeToken(buckets, clientKey(request))
        if (!verdict.allowed) {
          return yield* Effect.fail(limited(verdict.retryAfterSec))
        }
        return yield* httpEffect
      })
  }),
)
