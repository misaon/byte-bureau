import type { KernelServices } from '@bytebureau/kernel'
import { ByteSize, Layer, type FileSystem, type Path } from 'effect'
import {
  HttpIncomingMessage,
  HttpMiddleware,
  HttpRouter,
  type Etag,
  type HttpPlatform,
  type HttpServer,
} from 'effect/http'
import { HttpApiBuilder } from 'effect/http-api'
import type { SqlClient } from 'effect/sql'
import { API_PREFIX, BureauApi } from './api.js'
import { ApiConfig, type ApiOptions } from './config.js'
import { Handlers } from './handlers/all.js'
import { Middlewares } from './middlewares.js'

export const OPENAPI_PATH = `${API_PREFIX}/openapi.json` as const
const MAX_BODY = ByteSize.megabytes(10)

// What the platform layer of the server provides (BunHttpServer.layer in the binary, NodeHttpServer.layer under Vitest)
export type ServerPlatform =
  | HttpPlatform.HttpPlatform
  | FileSystem.FileSystem
  | Path.Path
  | Etag.Generator

// A handler reads the kernel when a request comes (a requirement of the request) or when the routes are built
export type ApiRequirements =
  | HttpRouter.HttpRouter
  | ServerPlatform
  | KernelServices
  | SqlClient.SqlClient
  | HttpRouter.Request.From<'Requires', KernelServices>

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

// Browsers may call the API only from the listed origins; with none listed there is no CORS at all (the embedded UI of SP2 is same-origin)
// A predicate rather than the list: with a list of one, Effect would name that origin to every requester
const Cors = (origins: readonly string[]): Layer.Layer<never, never, HttpRouter.HttpRouter> =>
  origins.length === 0
    ? Layer.empty
    : HttpRouter.use((router) =>
        router.addGlobalMiddleware(
          HttpMiddleware.cors({
            allowedOrigins: (origin) => origins.includes(origin),
            allowedMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['authorization', 'content-type', 'last-event-id'],
          }),
        ),
      )

const BodyLimit = Layer.succeed(HttpIncomingMessage.MaxBodySize, MAX_BODY)

// The routes of the API on the router of the environment; the OpenAPI document is served next to them
export const ApiLive = (options: ApiOptions): Layer.Layer<never, never, ApiRequirements> =>
  Layer.mergeAll(Routes(options), Cors(options.corsOrigins)).pipe(Layer.provide(BodyLimit))

// The API served by the HttpServer of the environment; the router is private to it
export const serveApi = (
  options: ApiOptions,
): Layer.Layer<
  never,
  never,
  HttpServer.HttpServer | ServerPlatform | KernelServices | SqlClient.SqlClient
> => HttpRouter.serve(ApiLive(options), { disableLogger: true })
