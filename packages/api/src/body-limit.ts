import { ByteSize, Effect } from 'effect'
import { HttpServerRequest, HttpServerResponse } from 'effect/http'
import { problem } from './problems.js'

// Decimal megabytes, as the platform limit (MaxBodySize) counts them
export const MAX_BODY_BYTES = ByteSize.toNumberUnsafe(ByteSize.megabytes(10))

const tooLarge = (): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    problem(413, 'payload_too_large', 'the request body exceeds 10 MB'),
    { status: 413, contentType: 'application/problem+json' },
  )

// A request without a length, or with one that is no number, is left to the platform limit
const declaredLength = (request: HttpServerRequest.HttpServerRequest): number =>
  Number(request.headers['content-length'])

// A body that declares itself larger than the limit is refused with a problem before any of it is read
// The platform limit stays as the backstop for a body without a length: Node drops that connection and Bun answers an empty 413
export const bodyLimit = <Failure, Requirements>(
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, Failure, Requirements>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Failure,
  Requirements | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* limitsBody() {
    const request = yield* HttpServerRequest.HttpServerRequest
    return declaredLength(request) > MAX_BODY_BYTES ? tooLarge() : yield* app
  })
