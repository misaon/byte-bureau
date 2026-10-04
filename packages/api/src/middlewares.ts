import { Layer, type Redacted } from 'effect'
import { AuthorizationLive, type Authorization } from './auth.js'
import type { ApiConfig } from './config.js'
import { MutationLimitLive, type MutationLimit } from './rate-limit.js'
import { RequestValidationLive, type RequestValidation } from './validation.js'

// The middlewares the groups declare: the bearer token, the validation of requests and the limit on mutations
export const Middlewares = (
  token: Redacted.Redacted,
): Layer.Layer<Authorization | RequestValidation | MutationLimit, never, ApiConfig> =>
  Layer.mergeAll(AuthorizationLive(token), RequestValidationLive, MutationLimitLive)
