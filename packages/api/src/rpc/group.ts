import { BureauRpcs } from '@bytebureau/protocol'
import { RpcAuthorization } from './auth.js'

export const WS_PATH = '/api/v1/ws'

// Every procedure, the subscription included, carries the bearer token in the headers of its request
export const BureauRpcsWithAuth = BureauRpcs.middleware(RpcAuthorization)
