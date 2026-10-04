import { ByteSize, Effect, Layer } from 'effect'
import { HttpIncomingMessage, HttpMiddleware, HttpRouter } from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import { API_PREFIX, BureauApi } from './api.js'
import { bodyLimit, MAX_BODY_BYTES } from './body-limit.js'
import { ApiConfig, type ApiOptions } from './config.js'
import { Handlers } from './handlers/all.js'
import { Middlewares } from './middlewares.js'
import type { ApiRequirements, ServeRequirements } from './requirements.js'
import { RpcRoute } from './rpc/route.js'

export const OPENAPI_PATH = `${API_PREFIX}/openapi.json` as const

// The endpoints of the API with their handlers and middlewares
// One configuration layer serves the middlewares, built with it, and the handlers, which read it with each request
const Routes = (options: ApiOptions): Layer.Layer<never, never, ApiRequirements> => {
  const config = Layer.succeed(ApiConfig, options)
  const middlewares = Middlewares(options.token).pipe(Layer.provide(config))
  return HttpApiBuilder.layer(BureauApi, { openapiPath: OPENAPI_PATH }).pipe(
    Layer.provide(Handlers),
    Layer.provide(middlewares),
    HttpRouter.provideRequest(config),
  )
}

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
export const ApiLive = (options: ApiOptions): Layer.Layer<never, never, ApiRequirements> =>
  Layer.mergeAll(
    Routes(options),
    Globals(options.corsOrigins),
    RpcRoute({ token: options.token, corsOrigins: options.corsOrigins }),
  ).pipe(Layer.provide(BodyLimit))

// The API served by the HttpServer of the environment; the router is private to it
export const serveApi = (options: ApiOptions): Layer.Layer<never, never, ServeRequirements> =>
  HttpRouter.serve(ApiLive(options), { disableLogger: true })
