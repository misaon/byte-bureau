import { Effect, type Layer } from 'effect'
import { HttpApiMiddleware } from 'effect/http-api'
import { Problem400, problem } from './problems.js'

// A body, query, path or header the schema refuses is a 400 problem that names the part and the reason
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  'bb/api/RequestValidation',
  { error: Problem400 },
) {}

export const RequestValidationLive: Layer.Layer<RequestValidation> =
  HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, (refused) =>
    Effect.fail(problem(400, 'request_invalid', `${refused.kind}: ${refused.cause.message}`)),
  )
