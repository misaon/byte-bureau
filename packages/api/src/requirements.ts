import type { KernelServices } from '@bytebureau/kernel'
import type { FileSystem, Path } from 'effect'
import type { Etag, HttpPlatform, HttpRouter, HttpServer } from 'effect/http'
import type { SqlClient } from 'effect/sql'

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

// What the served API needs from its environment: the server, its platform and the kernel
export type ServeRequirements =
  | HttpServer.HttpServer
  | ServerPlatform
  | KernelServices
  | SqlClient.SqlClient
