import { Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import { API_PREFIX, BureauApi } from './api.js'
import type { ApiConfig, ApiOptions } from './config.js'
import { Handlers } from './handlers/all.js'
import { Middlewares } from './middlewares.js'
import type { MutationBuckets } from './mutation-buckets.js'
import type { ApiRequirements } from './requirements.js'

export const OPENAPI_PATH = `${API_PREFIX}/openapi.json` as const

// The endpoints of the API with their handlers and middlewares; the handlers read the configuration with each request
export const Routes = (
  options: ApiOptions,
  config: Layer.Layer<ApiConfig>,
): Layer.Layer<never, never, ApiRequirements | MutationBuckets> =>
  HttpApiBuilder.layer(BureauApi, { openapiPath: OPENAPI_PATH }).pipe(
    Layer.provide(Handlers),
    Layer.provide(Middlewares(options.token)),
    HttpRouter.provideRequest(config),
  )
