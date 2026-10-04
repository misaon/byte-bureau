import { Layer, type Redacted } from 'effect'
import { AuthorizationLive, type Authorization } from './auth.js'
import type { MutationBuckets } from './mutation-buckets.js'
import { MutationLimitLive, type MutationLimit } from './rate-limit.js'
import { RequestValidationLive, type RequestValidation } from './validation.js'

// The middlewares the groups declare: the bearer token, the validation of requests and the limit on mutations
export const Middlewares = (
  token: Redacted.Redacted,
): Layer.Layer<Authorization | RequestValidation | MutationLimit, never, MutationBuckets> =>
  Layer.mergeAll(AuthorizationLive(token), RequestValidationLive, MutationLimitLive)
