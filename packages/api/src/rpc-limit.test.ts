import { createTempRepo } from '@bytebureau/kernel/testing'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, post, TEST_TOKEN } from './testing.js'
import { called, connected, type RequestEnvelope } from './testing-ws.js'

// One token per client, and the next flows back after a minute: the second mutation of a test is always refused
const ONE_TOKEN = ApiTestLayer({ mutationLimit: { capacity: 1, perMinute: 1 } })

// The registration of a new repository over the socket
const registration = (id: string, token?: string): RequestEnvelope => ({
  id,
  tag: 'projects.register',
  payload: { path: createTempRepo() },
  token,
})

const SUCCEEDED = { exit: { _tag: 'Success' } }

const LIMITED = {
  exit: {
    _tag: 'Failure',
    cause: [
      { _tag: 'Fail', error: { status: 429, code: 'rate_limited', detail: 'retry after 60 s' } },
    ],
  },
}

it.layer(ONE_TOKEN)('the mutation limit over the WebSocket of /api/v1/ws', (suite) => {
  suite.effect(
    'refuses the second mutation in a row with rate_limited and still streams events',
    () =>
      Effect.gen(function* limits() {
        const client = yield* connected()
        assert.containSubset(yield* called(client, registration('1', TEST_TOKEN)), SUCCEEDED)
        assert.containSubset(yield* called(client, registration('2', TEST_TOKEN)), {
          requestId: '2',
          ...LIMITED,
        })
        const subscription = { id: '3', tag: 'events.subscribe', payload: { since: 0 } }
        const first = yield* called(client, { ...subscription, token: TEST_TOKEN })
        assert.containSubset(first, { _tag: 'Chunk', requestId: '3' })
      }),
  )
})

it.layer(ONE_TOKEN)('one mutation budget for the REST API and the socket', (suite) => {
  suite.effect('refuses a REST mutation once the socket has spent the budget of the client', () =>
    Effect.gen(function* sharesBudget() {
      const client = yield* connected()
      assert.containSubset(yield* called(client, registration('1', TEST_TOKEN)), SUCCEEDED)
      const refused = yield* post('/projects', { path: createTempRepo() })
      assert.strictEqual(refused.status, 429)
      assert.containSubset(refused.body, { code: 'rate_limited', detail: 'retry after 60 s' })
    }),
  )
})

it.layer(ONE_TOKEN)('the mutation limit and the bearer token over the socket', (suite) => {
  suite.effect('does not count a request without the token against the limit', () =>
    Effect.gen(function* keepsToken() {
      const client = yield* connected()
      const unauthorized = { _tag: 'Fail', error: { code: 'unauthorized' } }
      const refused = yield* called(client, registration('1'))
      assert.containSubset(refused, { exit: { cause: [unauthorized] } })
      assert.containSubset(yield* called(client, registration('2', TEST_TOKEN)), SUCCEEDED)
    }),
  )
})
