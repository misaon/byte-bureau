import type { KernelServices } from '@bytebureau/kernel'
import { Effect, Layer, type Redacted } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import type { MutationBuckets } from '../mutation-buckets.js'
import { RpcAuthorizationLive } from './auth.js'
import { BureauRpcsWithAuth, WS_PATH } from './group.js'
import { RpcHandlers } from './handlers.js'
import { RpcMutationLimitLive } from './limit.js'
import { originAllowed } from './origin.js'

export interface RpcRouteOptions {
  readonly token: Redacted.Redacted
  readonly corsOrigins: readonly string[]
}

// GET /api/v1/ws: the RPC server of the group behind the origin check, with its handlers, its middlewares and JSON frames
// An origin that may not open the socket is turned away before the upgrade
// A defect of a handler ends that request with a Die instead of a Defect for the whole connection
export const RpcRoute = (
  options: RpcRouteOptions,
): Layer.Layer<never, never, HttpRouter.HttpRouter | KernelServices | MutationBuckets> =>
  HttpRouter.use((router) =>
    Effect.gen(function* registersRpc() {
      const upgrade = yield* RpcServer.toHttpEffectWebsocket(BureauRpcsWithAuth, {
        disableFatalDefects: true,
      })
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
    Layer.provide(RpcMutationLimitLive),
    Layer.provide(RpcSerialization.layerJson),
  )
