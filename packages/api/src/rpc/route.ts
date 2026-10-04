import type { KernelServices } from '@bytebureau/kernel'
import { Effect, Layer, type Redacted } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'
import type { MutationBuckets } from '../mutation-buckets.js'
import { RpcAuthorizationLive } from './auth.js'
import { BureauRpcsWithAuth, WS_PATH } from './group.js'
import { RpcHandlers } from './handlers.js'
import { RpcMutationLimitLive } from './limit.js'
import { guardedUpgrade } from './upgrade.js'

export interface RpcRouteOptions {
  readonly token: Redacted.Redacted
  readonly corsOrigins: readonly string[]
}

// GET /api/v1/ws: the RPC server of the group behind the origin check, with its handlers, its middlewares and JSON frames
// Before the upgrade, an origin that may not open the socket is turned away and the address of the client is captured
// A defect of a handler ends that request with a Die instead of a Defect for the whole connection
export const RpcRoute = (
  options: RpcRouteOptions,
): Layer.Layer<never, never, HttpRouter.HttpRouter | KernelServices | MutationBuckets> =>
  HttpRouter.use((router) =>
    Effect.gen(function* registersRpc() {
      const upgrade = yield* RpcServer.toHttpEffectWebsocket(BureauRpcsWithAuth, {
        disableFatalDefects: true,
      })
      yield* router.add('GET', WS_PATH, guardedUpgrade(upgrade, options.corsOrigins))
    }),
  ).pipe(
    Layer.provide(RpcHandlers),
    Layer.provide(RpcAuthorizationLive(options.token)),
    Layer.provide(RpcMutationLimitLive),
    Layer.provide(RpcSerialization.layerJson),
  )
