import { ByteSize, Effect, Layer } from 'effect'
import { HttpIncomingMessage, HttpMiddleware, HttpRouter } from 'effect/http'
import { bodyLimit, MAX_BODY_BYTES } from './body-limit.js'
import { ApiConfig, type ApiOptions } from './config.js'
import { MutationBucketsLive } from './mutation-buckets.js'
import type { ApiRequirements, ServeRequirements } from './requirements.js'
import { Routes } from './routes.js'
import { RpcRoute } from './rpc/route.js'

// What every request passes before it is routed: CORS and the limit on the length of its body
// Browsers may call the API only from the listed origins; with none listed there is no CORS at all (the embedded UI of SP2 is same-origin)
// A predicate rather than the list: with a list of one, Effect would name that origin to every requester
// The first middleware added is the outermost, so a refusal of the body limit carries the CORS headers too
const Globals = (origins: readonly string[]): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  HttpRouter.use((router) =>
    Effect.gen(function* addsGlobals() {
      if (origins.length > 0) {
        yield* router.addGlobalMiddleware(
          HttpMiddleware.cors({
            allowedOrigins: (origin) => origins.includes(origin),
            allowedMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['authorization', 'content-type', 'last-event-id'],
          }),
        )
      }
      yield* router.addGlobalMiddleware(bodyLimit)
    }),
  )

const BodyLimit = Layer.succeed(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES))

// The routes of the API on the router of the environment; the OpenAPI document and the RPC socket are served next to them
// One configuration layer serves the handlers and the mutation budgets, which the REST API and the socket share
export const ApiLive = (options: ApiOptions): Layer.Layer<never, never, ApiRequirements> => {
  const config = Layer.succeed(ApiConfig, options)
  const buckets = MutationBucketsLive.pipe(Layer.provide(config))
  return Layer.mergeAll(
    Routes(options, config),
    Globals(options.corsOrigins),
    RpcRoute({ token: options.token, corsOrigins: options.corsOrigins }),
  ).pipe(Layer.provide(BodyLimit), Layer.provide(buckets))
}

// The API served by the HttpServer of the environment; the router is private to it
export const serveApi = (options: ApiOptions): Layer.Layer<never, never, ServeRequirements> =>
  HttpRouter.serve(ApiLive(options), { disableLogger: true })
