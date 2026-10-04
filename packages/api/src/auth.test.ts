import { configJsonSchema, eventsJsonSchema } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Cause, Effect, Exit, Layer, Redacted } from 'effect'
import { describe, expect } from 'vitest'
import { AuthorizationLive, sameToken } from './auth.js'
import { openApiDocument } from './openapi.js'
import { ApiTestLayer, authorized, baseUrl, bodyOf, fetched, json } from './testing.js'

const EVENTS_SCHEMA = '/api/v1/schemas/events.json'

// What a refused request carries in its Authorization header: nothing, an empty bearer token, a wrong one
const REFUSED: [string, Record<string, string>][] = [
  ['no Authorization header', {}],
  ['an empty bearer token', { authorization: 'Bearer ' }],
  ['a wrong token', { authorization: 'Bearer not-the-token' }],
]

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])

// The method and the path of each operation of a path of the OpenAPI document, with an id where the path has one
const operationsOf = ([path, item]: [string, object]): [string, string][] =>
  Object.keys(item)
    .filter((method) => METHODS.has(method))
    .map((method) => [method.toUpperCase(), path.replace('{id}', 'x')])

// Every operation the document lists but the health check
const PROTECTED = Object.entries(openApiDocument().paths)
  .filter(([path]) => path !== '/api/v1/health')
  .flatMap((entry) => operationsOf(entry))

// What building the layer dies with, or nothing when it builds
const buildFailure = <Out>(layer: Layer.Layer<Out>): string => {
  const built = Effect.runSyncExit(Effect.scoped(Layer.build(layer)))
  return Exit.match(built, { onFailure: (cause) => Cause.pretty(cause), onSuccess: () => '' })
}

describe(sameToken, () => {
  it('is true only for the same token, whatever the length of the other, and never for an empty one', () => {
    expect(sameToken('abc', 'abc')).toBe(true)
    expect(sameToken('abc', 'abd')).toBe(false)
    expect(sameToken('ab', 'abc')).toBe(false)
    expect(sameToken('', '')).toBe(false)
  })
})

describe(AuthorizationLive, () => {
  it('refuses to build without a token, which would let every request in', () => {
    const withoutToken = AuthorizationLive(Redacted.make(''))
    expect(buildFailure(withoutToken)).toContain('the API token must not be empty')
    const withToken = AuthorizationLive(Redacted.make('token'))
    expect(buildFailure(withToken)).toBe('')
  })
})

it.layer(ApiTestLayer())('the bearer token on a protected endpoint', (suite) => {
  suite.effect.each(REFUSED)('refuses %s with the 401 problem', ([, headers]) =>
    Effect.gen(function* refuses() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}${EVENTS_SCHEMA}`, { headers })
      assert.strictEqual(response.status, 401)
      assert.include(response.headers.get('content-type'), 'application/problem+json')
      assert.deepStrictEqual(yield* bodyOf(response), {
        type: 'https://bytebureau.dev/problems/unauthorized',
        title: 'Unauthorized',
        status: 401,
        detail: 'a valid API token is required',
        code: 'unauthorized',
      })
    }),
  )

  suite.effect('refuses a body over 10 MB with the 413 problem before any handler runs', () =>
    Effect.gen(function* refusesBig() {
      const base = yield* baseUrl
      const oversized = json({ path: 'x'.repeat(11 * 1024 * 1024) })
      const response = yield* fetched(`${base}/api/v1/projects`, oversized)
      assert.strictEqual(response.status, 413)
      assert.include(response.headers.get('content-type'), 'application/problem+json')
      assert.containSubset(yield* bodyOf(response), { status: 413, code: 'payload_too_large' })
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

it.layer(ApiTestLayer())('the bearer token on every operation of the API', (suite) => {
  suite.effect.each(PROTECTED)('refuses %s %s without it', ([method, path]) =>
    Effect.gen(function* refuses() {
      const base = yield* baseUrl
      const response = yield* fetched(`${base}${path}`, { method })
      assert.strictEqual(response.status, 401)
      assert.containSubset(yield* bodyOf(response), { code: 'unauthorized' })
    }),
  )
})
