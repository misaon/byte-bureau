import { Problem } from '@bytebureau/protocol'
import { Effect, Layer, Option, Redacted } from 'effect'
import { Headers } from 'effect/http'
import { RpcMiddleware } from 'effect/rpc'
import { sameToken, UNAUTHORIZED } from '../auth.js'

export class RpcAuthorization extends RpcMiddleware.Service<RpcAuthorization>()(
  'bb/api/RpcAuthorization',
  { error: Problem, requiredForClient: true },
) {}

const BEARER = 'bearer '

// The token of a request: the authorization header of its envelope, whatever the case of the scheme
// The headers come from the wire as the client wrote them, so a value that is no text carries no token
export const bearerOf = (headers: Headers.Headers): string | undefined => {
  const value = Option.getOrUndefined(Headers.get(headers, 'authorization'))
  if (typeof value !== 'string' || !value.toLowerCase().startsWith(BEARER)) {
    return undefined
  }
  return value.slice(BEARER.length).trim()
}

// Built the way AuthorizationLive is: an empty token is a programming error and dies at construction
export const RpcAuthorizationLive = (token: Redacted.Redacted): Layer.Layer<RpcAuthorization> =>
  Layer.effect(
    RpcAuthorization,
    Redacted.value(token) === ''
      ? Effect.die(new Error('the API token must not be empty'))
      : Effect.succeed((effect, { headers }) => {
          const given = bearerOf(headers)
          return given !== undefined && sameToken(given, Redacted.value(token))
            ? effect
            : Effect.fail(UNAUTHORIZED)
        }),
  )
