import { BureauRpcs } from '@bytebureau/protocol'
import { RpcAuthorization } from './auth.js'
import { RpcMutationLimit } from './limit.js'

export const WS_PATH = '/api/v1/ws'

// Every procedure, the subscription included, carries the bearer token in the headers of its request
// The middleware added last wraps the others: a request without a valid token is refused before it costs a token of the limit
export const BureauRpcsWithAuth =
  BureauRpcs.middleware(RpcMutationLimit).middleware(RpcAuthorization)
