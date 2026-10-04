import type { KernelServices } from '@bytebureau/kernel'
import { Effect, Layer, Option, type Redacted } from 'effect'
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import { RpcAuthorizationLive } from './auth.js'
import { BureauRpcsWithAuth, WS_PATH } from './group.js'
import { RpcHandlers } from './handlers.js'

export interface RpcRouteOptions {
  readonly token: Redacted.Redacted
  readonly corsOrigins: readonly string[]
}

// A browser says where it comes from; an origin the daemon does not serve is turned away before the socket opens
const originAllowed = (headers: Headers.Headers, origins: readonly string[]): boolean => {
  const origin = Option.getOrUndefined(Headers.get(headers, 'origin'))
  return origin === undefined || origins.includes(origin)
}

// GET /api/v1/ws: the RPC server of the group behind the origin check, with its handlers, its middleware and JSON frames
export const RpcRoute = (
  options: RpcRouteOptions,
): Layer.Layer<never, never, HttpRouter.HttpRouter | KernelServices> =>
  HttpRouter.use((router) =>
    Effect.gen(function* registersRpc() {
      const upgrade = yield* RpcServer.toHttpEffectWebsocket(BureauRpcsWithAuth)
      yield* router.add(
        'GET',
        WS_PATH,
        Effect.gen(function* guardsUpgrade() {
          const request = yield* HttpServerRequest.HttpServerRequest
          return originAllowed(request.headers, options.corsOrigins)
            ? yield* upgrade
            : HttpServerResponse.empty({ status: 403 })
        }),
      )
    }),
  ).pipe(
    Layer.provide(RpcHandlers),
    Layer.provide(RpcAuthorizationLive(options.token)),
    Layer.provide(RpcSerialization.layerJson),
  )
