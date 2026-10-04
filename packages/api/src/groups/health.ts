import { HealthDto } from '@bytebureau/protocol'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { RequestValidation } from '../validation.js'

// The one group without a bearer token: a client checks the daemon with it before it has read the token
export const HealthGroup = HttpApiGroup.make('health')
  .add(HttpApiEndpoint.get('check', '/health', { success: HealthDto }))
  .middleware(RequestValidation)
