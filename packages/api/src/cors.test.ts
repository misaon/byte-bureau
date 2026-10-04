import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, baseUrl, fetched } from './testing.js'

const UI = 'http://ui.test'

// The preflight a browser sends from the origin before it reads the events schema
const preflight = (origin: string): RequestInit => ({
  method: 'OPTIONS',
  headers: { origin, 'access-control-request-method': 'GET' },
})

it.layer(ApiTestLayer({ corsOrigins: [UI] }))('CORS for a configured origin', (suite) => {
  suite.effect('answers the preflight of the origin with the origin and the token header', () =>
    Effect.gen(function* answersPreflight() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}/api/v1/schemas/events.json`, preflight(UI))
      assert.strictEqual(response.status, 204)
      assert.strictEqual(response.headers.get('access-control-allow-origin'), UI)
      assert.include(response.headers.get('access-control-allow-headers'), 'authorization')
    }),
  )

  suite.effect('names no origin to an origin off the list', () =>
    Effect.gen(function* refusesOthers() {
      const base = yield* baseUrl
      const other = preflight('http://elsewhere.test')
      const response = yield* fetched(`${base}/api/v1/schemas/events.json`, other)
      assert.isNull(response.headers.get('access-control-allow-origin'))
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
