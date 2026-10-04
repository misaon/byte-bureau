import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, baseUrl, fetched } from './testing.js'

const UI = 'http://ui.test'

it.layer(ApiTestLayer({ corsOrigins: [UI] }))('CORS for a configured origin', (suite) => {
  suite.effect('answers the preflight of the origin with the origin and the token header', () =>
    Effect.gen(function* answersPreflight() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/api/v1/schemas/events.json`, {
        method: 'OPTIONS',
        headers: { origin: UI, 'access-control-request-method': 'GET' },
      })
      assert.strictEqual(response.status, 204)
      assert.strictEqual(response.headers.get('access-control-allow-origin'), UI)
      assert.include(response.headers.get('access-control-allow-headers'), 'authorization')
    }),
  )
})

it.layer(ApiTestLayer())('CORS by default', (suite) => {
  suite.effect('lets no browser origin read an answer', () =>
    Effect.gen(function* refusesOrigins() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/api/v1/health`, { headers: { origin: UI } })
      assert.strictEqual(response.status, 200)
      assert.isNull(response.headers.get('access-control-allow-origin'))
    }),
  )
})
