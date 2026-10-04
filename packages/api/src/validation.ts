import { Effect, type Layer } from 'effect'
import { HttpApiMiddleware } from 'effect/http-api'
import { logApiError } from './logging.js'
import { Problem400, Problem500, problem, UNEXPECTED_FAILURE } from './problems.js'

// A body, query, path or header the schema refuses is a 400 problem that names the part and the reason
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  'bb/api/RequestValidation',
  { error: [Problem400, Problem500] },
) {}

// A response its own schema refuses is a fault of the server: logged, and told as an unexpected failure
const RESPONSE_PARTS: ReadonlySet<string> = new Set(['Body', 'ResponseHeaders'])

export const RequestValidationLive: Layer.Layer<RequestValidation> =
  HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, (refused) =>
    RESPONSE_PARTS.has(refused.kind)
      ? logApiError('a response its schema refuses', refused.cause).pipe(
          Effect.andThen(Effect.fail(UNEXPECTED_FAILURE)),
        )
      : Effect.fail(problem(400, 'request_invalid', `${refused.kind}: ${refused.cause.message}`)),
  )
