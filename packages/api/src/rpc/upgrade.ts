import { Effect, type Scope } from 'effect'
import { HttpServerRequest, HttpServerResponse } from 'effect/http'
import { originAllowed } from './origin.js'

type Upgrade = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | Scope.Scope
>

// Bun forgets the address of a request once it has upgraded it, so the address is captured before the upgrade
// The requests on the socket run in the context of this request, and the mutation limit counts them for that address
const frozenRequest = (
  request: HttpServerRequest.HttpServerRequest,
): HttpServerRequest.HttpServerRequest => request.modify({ remoteAddress: request.remoteAddress })

// The upgrade behind the origin check: a browser from an origin the daemon does not serve gets 403 before the socket opens
export const guardedUpgrade = (upgrade: Upgrade, origins: readonly string[]): Upgrade =>
  Effect.gen(function* guardsUpgrade() {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (!originAllowed(request.headers, origins)) {
      return HttpServerResponse.empty({ status: 403 })
    }
    return yield* upgrade.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, frozenRequest(request)),
    )
  })
