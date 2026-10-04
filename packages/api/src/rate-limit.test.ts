import { createTempRepo } from '@bytebureau/kernel/testing'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, baseUrl, fetched, get, post } from './testing.js'

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
