import { configJsonSchema, eventsJsonSchema } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect } from 'vitest'
import { sameToken } from './auth.js'
import { ApiTestLayer, authorized, baseUrl, bodyOf, fetched, json } from './testing.js'

const EVENTS_SCHEMA = '/api/v1/schemas/events.json'

describe(sameToken, () => {
  it('is true only for the same token, whatever the length of the other', () => {
    expect(sameToken('abc', 'abc')).toBe(true)
    expect(sameToken('abc', 'abd')).toBe(false)
    expect(sameToken('ab', 'abc')).toBe(false)
    expect(sameToken('', '')).toBe(true)
  })
})

it.layer(ApiTestLayer())('the bearer token on a protected endpoint', (suite) => {
  suite.effect('is required: a request without the header gets the 401 problem', () =>
    Effect.gen(function* refusesMissing() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}${EVENTS_SCHEMA}`)
      assert.strictEqual(response.status, 401)
      assert.containSubset(yield* bodyOf(response), { code: 'unauthorized' })
    }),
  )

  suite.effect('is checked: a wrong token is a 401 problem', () =>
    Effect.gen(function* refusesWrong() {
      const base = yield* baseUrl
      const wrong = { headers: { authorization: 'Bearer not-the-token' } }
      const response = yield* fetched(`${base}${EVENTS_SCHEMA}`, wrong)
      assert.strictEqual(response.status, 401)
      assert.include(response.headers.get('content-type'), 'application/problem+json')
      assert.deepStrictEqual(yield* bodyOf(response), {
        type: 'https://bytebureau.dev/problems/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'a valid bearer token is required',
        code: 'unauthorized',
      })
    }),
  )

  // POST /api/v1/projects arrives with Task 4, which un-skips this test
  suite.effect.skip('refuses a body over 10 MB with 413 before any handler runs', () =>
    Effect.gen(function* refusesBig() {
      const base = yield* baseUrl
      const oversized = json({ path: 'x'.repeat(11 * 1024 * 1024) })
      const response = yield* fetched(`${base}/api/v1/projects`, oversized)
      assert.strictEqual(response.status, 413)
    }),
  )

  suite.effect('opens the endpoints: the schemas are the ones the protocol publishes', () =>
    Effect.gen(function* serves() {
      const base = yield* baseUrl
      const events = yield* fetched(`${base}${EVENTS_SCHEMA}`, authorized())
      assert.strictEqual(events.status, 200)
      assert.deepStrictEqual(yield* bodyOf(events), eventsJsonSchema())
      const config = yield* fetched(`${base}/api/v1/schemas/config.json`, authorized())
      assert.deepStrictEqual(yield* bodyOf(config), configJsonSchema())
    }),
  )
})
