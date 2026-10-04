import { Layer } from 'effect'
import { AuthorizationLive, type Authorization } from './auth.js'
import { ApiConfig, type ApiOptions } from './config.js'
import { MutationLimitLive, type MutationLimit } from './rate-limit.js'
import { RequestValidationLive, type RequestValidation } from './validation.js'

// The middlewares the groups declare: the bearer token, the validation of requests and the limit on mutations
export const Middlewares = (
  options: ApiOptions,
): Layer.Layer<Authorization | RequestValidation | MutationLimit> =>
  Layer.mergeAll(AuthorizationLive(options.token), RequestValidationLive, MutationLimitLive).pipe(
    Layer.provide(Layer.succeed(ApiConfig, options)),
  )
