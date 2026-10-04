import { createBureauClient, type BureauClient, type RpcConnection } from '@bytebureau/client'
import { Effect, type Scope } from 'effect'
import type { HttpServer } from 'effect/http'
import { WS_PATH } from './rpc/group.js'
import { baseUrl, TEST_TOKEN } from './testing.js'

// The client of the server under test, made as the CLI makes it
export const client: Effect.Effect<BureauClient, never, HttpServer.HttpServer> = baseUrl.pipe(
  Effect.map((url) => createBureauClient({ baseUrl: url, token: TEST_TOKEN })),
)

// The url of the RPC socket of the server under test
export const wsUrl: Effect.Effect<string, never, HttpServer.HttpServer> = baseUrl.pipe(
  Effect.map((url) => `${url.replace(/^http/u, 'ws')}${WS_PATH}`),
)

// What a call of the client resolves with; a rejection fails the test
export const awaited = <Value>(call: Promise<Value>): Effect.Effect<Value> =>
  Effect.promise(async () => {
    const value = await call
    return value
  })

// What a call that has to fail failed with
export const refused = (call: Promise<unknown>): Effect.Effect<unknown> =>
  Effect.promise(async () => {
    try {
      await call
    } catch (error) {
      return error
    }
    return 'not refused'
  })

// An RPC connection that closes with the test, whatever its outcome
export const opened = (
  connect: Promise<RpcConnection>,
): Effect.Effect<RpcConnection, never, Scope.Scope> =>
  Effect.acquireRelease(awaited(connect), (connection) =>
    Effect.sync(() => {
      connection.close()
    }),
  )
