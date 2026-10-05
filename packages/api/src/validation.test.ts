import { createServer } from 'node:http'
import { NodeHttpServer } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import { Effect, Layer, Logger, References, Schema } from 'effect'
import { HttpRouter } from 'effect/http'
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { baseUrl, bodyOf, fetched } from './testing.js'
import { RequestValidation, RequestValidationLive } from './validation.js'

// A check whose own message would repeat the value it refused
const Key = Schema.String.check(
  Schema.makeFilter((value: string) => value.startsWith('x') || `not a key: ${value}`),
)

// An endpoint that reads a number from its query, one that reads a key, and one whose answer its own schema refuses
const Probe = HttpApi.make('probe').add(
  HttpApiGroup.make('probe')
    .add(
      HttpApiEndpoint.get('since', '/since', {
        query: { since: Schema.FiniteFromString },
        success: Schema.Finite,
      }),
      HttpApiEndpoint.get('keyed', '/keyed', { query: { key: Key }, success: Schema.String }),
      HttpApiEndpoint.get('broken', '/broken', { success: Schema.Int }),
    )
    .middleware(RequestValidation),
)

const ProbeHandlers = HttpApiBuilder.group(Probe, 'probe', (handlers) =>
  handlers
    .handle('since', ({ query }) => Effect.succeed(query.since))
    .handle('keyed', ({ query }) => Effect.succeed(query.key))
    .handle('broken', () => Effect.succeed(0.5)),
)

// The categories of the lines the server logs
const categories: unknown[] = []
const capture = Logger.make((options) => {
  categories.push(options.fiber.getRef(References.CurrentLogAnnotations)['category'])
})

const ProbeServer = HttpRouter.serve(
  HttpApiBuilder.layer(Probe).pipe(
    Layer.provide(ProbeHandlers),
    Layer.provide(RequestValidationLive),
  ),
  { disableLogger: true, disableListenLog: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: '127.0.0.1' })),
  Layer.provide(Logger.layer([capture])),
)

it.layer(ProbeServer)('RequestValidation', (suite) => {
  suite.effect('answers input the schema refuses with a 400 problem that names the part', () =>
    Effect.gen(function* refusesInput() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/since?since=soon`)
      assert.strictEqual(response.status, 400)
      assert.include(response.headers.get('content-type'), 'application/problem+json')
      assert.containSubset(yield* bodyOf(response), {
        code: 'request_invalid',
        detail: 'Query: Expected a finite number\n  at ["since"]',
      })
    }),
  )

  suite.effect('names the place and the shape it expected, never a value the request held', () =>
    Effect.gen(function* refusesWithoutValue() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/keyed?key=sk-canary-validation`)
      const body = yield* bodyOf(response)
      assert.strictEqual(response.status, 400)
      assert.notInclude(JSON.stringify(body), 'sk-canary-validation')
      assert.containSubset(body, {
        code: 'request_invalid',
        detail: 'Query: Expected a valid value\n  at ["key"]',
      })
    }),
  )

  suite.effect('answers a response its schema refuses as an internal failure and logs it', () =>
    Effect.gen(function* refusesResponse() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/broken`)
      assert.strictEqual(response.status, 500)
      assert.deepStrictEqual(yield* bodyOf(response), {
        type: 'https://bytebureau.dev/problems/internal',
        title: 'Internal Server Error',
        status: 500,
        detail: 'unexpected failure',
        code: 'internal',
      })
      assert.deepStrictEqual(categories, ['bb.api'])
    }),
  )
})
