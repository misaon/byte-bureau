import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, baseUrl, bodyOf, fetched } from './testing.js'

it.layer(ApiTestLayer())('GET /api/v1/health over the test kernel', (suite) => {
  suite.effect('answers without a token with the status, the version and the checks', () =>
    Effect.gen(function* checksHealth() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/api/v1/health`)
      assert.strictEqual(response.status, 200)
      assert.include(response.headers.get('content-type'), 'application/json')
      assert.deepStrictEqual(yield* bodyOf(response), {
        status: 'ok',
        version: '0.0.0-test',
        startedAt: '2026-10-04T00:00:00.000Z',
        checks: { store: 'ok', plugins: { loaded: 2, failed: 0 } },
      })
    }),
  )

  suite.effect('serves the OpenAPI document without a token', () =>
    Effect.gen(function* readsOpenApi() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/api/v1/openapi.json`)
      assert.strictEqual(response.status, 200)
      assert.containSubset(yield* bodyOf(response), {
        openapi: '3.1.0',
        info: { title: 'ByteBureau API' },
      })
    }),
  )
})
