import { createServer } from 'node:http'
import type { KernelServices } from '@bytebureau/kernel'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer, Redacted } from 'effect'
import { HttpServer, type HttpServerError } from 'effect/http'
import type { SqlClient } from 'effect/sql'
import { API_PREFIX } from './api.js'
import { DEFAULT_API_OPTIONS, type ApiOptions } from './config.js'
import { serveApi } from './layer.js'
import { BootedKernel } from './testing-kernel.js'

export const TEST_TOKEN = 'test-token-0123456789abcdef0123456789abcdef0123456789abcdef'

export const testOptions = (overrides: Partial<ApiOptions> = {}): ApiOptions => ({
  ...DEFAULT_API_OPTIONS,
  version: '0.0.0-test',
  startedAt: '2026-10-04T00:00:00.000Z',
  token: Redacted.make(TEST_TOKEN),
  ...overrides,
})

// The API over the test kernel on an ephemeral loopback port of the Node server; a test reads the address from HttpServer
export const ApiTestLayer = (
  overrides: Partial<ApiOptions> = {},
): Layer.Layer<
  HttpServer.HttpServer | KernelServices | SqlClient.SqlClient,
  HttpServerError.ServeError
> =>
  serveApi(testOptions(overrides)).pipe(
    Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: '127.0.0.1' })),
    Layer.provideMerge(BootedKernel),
  )

// http://127.0.0.1:<port>, whatever form the platform prints the address in
export const baseUrl: Effect.Effect<string, never, HttpServer.HttpServer> =
  HttpServer.addressFormattedWith((address) =>
    Effect.succeed(address.startsWith('http') ? address : `http://${address}`),
  )

// The request with the bearer token of the tests added to the headers it already has
export const authorized = (init: RequestInit = {}): RequestInit => {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${TEST_TOKEN}`)
  return { ...init, headers }
}

export const json = (body: unknown): RequestInit =>
  authorized({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

// What the server answers, as an effect a test yields
export const fetched = (url: string, init?: RequestInit): Effect.Effect<Response> =>
  Effect.promise(async () => {
    const response = await fetch(url, init)
    return response
  })

// The JSON body of an answer
export const bodyOf = (response: Response): Effect.Effect<unknown> =>
  Effect.promise(async () => {
    const body: unknown = await response.json()
    return body
  })

// What the server answered to a call: the status, the content type and the JSON of the body, when it has one
export interface Reply {
  readonly status: number
  readonly type: string | null
  readonly body: unknown
}

const call = (
  path: string,
  init: RequestInit,
): Effect.Effect<Reply, never, HttpServer.HttpServer> =>
  Effect.gen(function* calls() {
    const base = yield* baseUrl
    const response = yield* fetched(`${base}${API_PREFIX}${path}`, init)
    const text = yield* Effect.promise(async () => {
      const whole = await response.text()
      return whole
    })
    const body: unknown = text === '' ? undefined : JSON.parse(text)
    return { status: response.status, type: response.headers.get('content-type'), body }
  })

// The calls a test makes under /api/v1, each with the token of the tests
export const get = (path: string): Effect.Effect<Reply, never, HttpServer.HttpServer> =>
  call(path, authorized())

// A body of JSON, or none for a command that takes none
export const post = (
  path: string,
  body?: unknown,
): Effect.Effect<Reply, never, HttpServer.HttpServer> =>
  call(path, body === undefined ? authorized({ method: 'POST' }) : json(body))

export const remove = (path: string): Effect.Effect<Reply, never, HttpServer.HttpServer> =>
  call(path, authorized({ method: 'DELETE' }))
