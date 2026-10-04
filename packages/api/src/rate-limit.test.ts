import { createTempRepo } from '@bytebureau/kernel/testing'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { ApiTestLayer, baseUrl, fetched, get, json, post } from './testing.js'

// The budget runs on the TestClock of the suite: no token flows back unless a test moves the clock
const TWO_TOKENS = ApiTestLayer({ mutationLimit: { capacity: 2, perMinute: 60 } })

it.layer(TWO_TOKENS)('the mutation rate limit with two tokens', (suite) => {
  suite.effect(
    'answers the third mutation in a row with 429 rate_limited and still serves reads',
    () =>
      Effect.gen(function* limits() {
        const repos = [createTempRepo(), createTempRepo(), createTempRepo()]
        const replies = yield* Effect.all(repos.map((path) => post('/projects', { path })))
        assert.deepStrictEqual(
          replies.map((reply) => reply.status),
          [201, 201, 429],
        )
        const limited = yield* Effect.fromNullishOr(replies[2])
        assert.include(limited.type, 'application/problem+json')
        assert.containSubset(limited.body, {
          code: 'rate_limited',
          status: 429,
          detail: 'retry after 1 s',
        })
        assert.strictEqual((yield* get('/projects')).status, 200)
      }),
  )

  suite.effect('says when to retry in the Retry-After header as well', () =>
    Effect.gen(function* retryAfter() {
      const base = yield* baseUrl
      const refused = yield* fetched(`${base}/api/v1/projects`, json({ path: createTempRepo() }))
      assert.strictEqual(refused.status, 429)
      assert.strictEqual(refused.headers.get('retry-after'), '1')
    }),
  )

  suite.effect('serves a mutation again once the clock has let a token flow back', () =>
    Effect.gen(function* refills() {
      const refused = yield* post('/projects', { path: createTempRepo() })
      yield* TestClock.adjust('1 second')
      const served = yield* post('/projects', { path: createTempRepo() })
      assert.deepStrictEqual([refused.status, served.status], [429, 201])
    }),
  )
})

it.layer(TWO_TOKENS)('the mutation rate limit and the bearer token', (suite) => {
  suite.effect('does not count a request without the token against the limit', () =>
    Effect.gen(function* keepsTokens() {
      const base = yield* baseUrl
      const refused = yield* Effect.forEach([1, 2, 3], () =>
        fetched(`${base}/api/v1/projects`, { method: 'POST' }),
      )
      assert.deepStrictEqual(
        refused.map((response) => response.status),
        [401, 401, 401],
      )
      const replies = yield* Effect.forEach([createTempRepo(), createTempRepo()], (path) =>
        post('/projects', { path }),
      )
      assert.deepStrictEqual(
        replies.map((reply) => reply.status),
        [201, 201],
      )
    }),
  )
})
