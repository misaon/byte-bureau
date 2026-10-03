import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { SqlClient } from 'effect/sql'
import type { StoreError } from '../errors.js'
import { buildAsk } from './ask-build.js'
import { askOf, request } from './ask-fixtures.js'
import { insertAsk } from './ask-records.js'
import { AskService, type AskServiceShape } from './ask-service.js'
import {
  codeOf,
  eventsOf,
  reasonOf,
  rowOf,
  seedSession,
  seedTurn,
  TestLayer,
} from './ask-service-fixtures.js'

it.layer(TestLayer)('AskService refusals', (suite) => {
  suite.effect('refuses a second answer and keeps the first', () =>
    Effect.gen(function* refusesSecondAnswer() {
      yield* seedSession('refuse-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('refuse-1'))
      yield* asks.answer(ask.id, { selected: ['b'] }, 'cli')
      const error = yield* Effect.flip(asks.answer(ask.id, { selected: ['a'] }, 'api'))
      assert.strictEqual(codeOf(error), 'not_pending')
      assert.strictEqual((yield* rowOf(ask.id)).answered_via, 'cli')
      assert.strictEqual((yield* eventsOf('refuse-1')).length, 2)
    }),
  )

  suite.effect('refuses an answer for an ask nobody opened', () =>
    Effect.gen(function* refusesUnknownAsk() {
      const asks = yield* AskService
      const error = yield* Effect.flip(asks.answer('nobody', { selected: ['a'] }, 'cli'))
      assert.strictEqual(codeOf(error), 'not_found')
    }),
  )

  suite.effect('lets a caller that waits only after the answer still have it', () =>
    Effect.gen(function* answersBeforeWait() {
      yield* seedSession('refuse-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('refuse-2'))
      yield* asks.answer(ask.id, { selected: ['b'] }, 'api')
      assert.deepStrictEqual(yield* asks.await(ask.id), { selected: ['b'] })
      assert.deepStrictEqual(yield* asks.await(ask.id), { selected: ['b'] })
    }),
  )

  suite.effect('fails the wait for an ask this process never opened', () =>
    Effect.gen(function* waitsForStranger() {
      const asks = yield* AskService
      const error = yield* Effect.flip(asks.await('nobody'))
      assert.strictEqual(codeOf(error), 'not_found')
    }),
  )
})

it.layer(TestLayer)('AskService cancel', (suite) => {
  suite.effect('fails the caller that waits and announces the cancellation', () =>
    Effect.gen(function* cancelsWaitedAsk() {
      yield* seedSession('cancel-1')
      yield* seedTurn('cancel-1', 'turn-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('cancel-1', { turnId: 'turn-1' }))
      const waiting = yield* Effect.forkChild(Effect.flip(asks.await(ask.id)))
      yield* asks.cancel(ask.id)
      assert.strictEqual(codeOf(yield* Fiber.join(waiting)), 'not_pending')
      assert.strictEqual((yield* rowOf(ask.id)).status, 'cancelled')
      assert.deepStrictEqual(yield* eventsOf('cancel-1'), [
        { type: 'ask.requested', turnId: 'turn-1', payload: { ask: askOf(ask) } },
        { type: 'ask.cancelled', turnId: 'turn-1', payload: { askId: ask.id } },
      ])
    }),
  )

  suite.effect('takes a cancelled ask off the pending list and refuses its answer', () =>
    Effect.gen(function* refusesCancelledAsk() {
      yield* seedSession('cancel-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('cancel-2'))
      yield* asks.cancel(ask.id)
      assert.deepStrictEqual(yield* asks.pending('cancel-2'), [])
      const error = yield* Effect.flip(asks.answer(ask.id, { selected: ['a'] }, 'cli'))
      assert.strictEqual(codeOf(error), 'not_pending')
      assert.strictEqual(reasonOf(error), `ask ${ask.id} is cancelled`)
    }),
  )
})

it.layer(TestLayer)('AskService late cancel', (suite) => {
  suite.effect('fails a wait that starts after the cancellation', () =>
    Effect.gen(function* waitsAfterCancel() {
      yield* seedSession('cancel-3')
      const asks = yield* AskService
      const ask = yield* asks.open(request('cancel-3'))
      yield* asks.cancel(ask.id)
      const error = yield* Effect.flip(asks.await(ask.id))
      assert.strictEqual(codeOf(error), 'not_pending')
    }),
  )

  suite.effect('cancels nothing that is answered, cancelled already or unknown', () =>
    Effect.gen(function* cancelsNothing() {
      yield* seedSession('cancel-4')
      const asks = yield* AskService
      const ask = yield* asks.open(request('cancel-4'))
      yield* asks.answer(ask.id, { selected: ['a'] }, 'cli')
      yield* Effect.all([asks.cancel(ask.id), asks.cancel(ask.id), asks.cancel('nobody')])
      assert.strictEqual((yield* rowOf(ask.id)).status, 'answered')
      assert.strictEqual((yield* eventsOf('cancel-4')).length, 2)
    }),
  )
})

const idsPending = (
  asks: AskServiceShape,
  sessionId?: string,
): Effect.Effect<readonly string[], StoreError> =>
  Effect.map(asks.pending(sessionId), (records) => records.map((record) => record.id))

// Alone in its layer, so that the list of every pending ask is the one this test made
it.layer(TestLayer)('AskService pending order', (suite) => {
  suite.effect('lists the pending asks oldest first and narrows them by session', () =>
    Effect.gen(function* listsPending() {
      yield* Effect.all([seedSession('list-1'), seedSession('list-2')])
      const asks = yield* AskService
      const first = yield* asks.open(request('list-1', { title: 'first' }))
      const second = yield* asks.open(request('list-2', { title: 'second' }))
      const third = yield* asks.open(request('list-1', { title: 'third' }))
      assert.deepStrictEqual(yield* idsPending(asks), [first.id, second.id, third.id])
      assert.deepStrictEqual(yield* idsPending(asks, 'list-1'), [first.id, third.id])
      assert.deepStrictEqual(yield* idsPending(asks, 'list-2'), [second.id])
    }),
  )
})

it.layer(TestLayer)('AskService pending', (suite) => {
  suite.effect('leaves an answered ask out of the list', () =>
    Effect.gen(function* dropsAnswered() {
      yield* seedSession('list-3')
      const asks = yield* AskService
      const first = yield* asks.open(request('list-3'))
      const second = yield* asks.open(request('list-3'))
      yield* asks.answer(first.id, { selected: ['a'] }, 'cli')
      assert.deepStrictEqual(yield* idsPending(asks, 'list-3'), [second.id])
    }),
  )
})

it.layer(TestLayer)('AskService after a restart', (suite) => {
  suite.effect('answers an ask a former process left pending but cannot be waited for', () =>
    Effect.gen(function* answersLeftover() {
      yield* seedSession('left-1')
      const sql = yield* SqlClient.SqlClient
      const ask = buildAsk(request('left-1'))
      yield* insertAsk(sql, ask)
      const asks = yield* AskService
      assert.deepStrictEqual(yield* idsPending(asks, 'left-1'), [ask.id])
      const error = yield* Effect.flip(asks.await(ask.id))
      assert.strictEqual(codeOf(error), 'not_found')
      yield* asks.answer(ask.id, { selected: ['a'] }, 'api')
      assert.strictEqual((yield* rowOf(ask.id)).status, 'answered')
    }),
  )

  suite.effect('cancels such an ask as well', () =>
    Effect.gen(function* cancelsLeftover() {
      yield* seedSession('left-2')
      const sql = yield* SqlClient.SqlClient
      const ask = buildAsk(request('left-2'))
      yield* insertAsk(sql, ask)
      const asks = yield* AskService
      yield* asks.cancel(ask.id)
      assert.strictEqual((yield* rowOf(ask.id)).status, 'cancelled')
    }),
  )
})
