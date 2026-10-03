import { assert, it } from '@effect/vitest'
import { Effect, Fiber, Latch, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { StoreTest } from '../store/store-test.js'
import { request } from './ask-fixtures.js'
import { AskService, AskServiceLive, type AskServiceShape } from './ask-service.js'
import {
  askIdsOf,
  codeOf,
  eventsOf,
  flush,
  holdingLog,
  ownService,
  refusingLog,
  rowOf,
  seedSession,
} from './ask-service-fixtures.js'

// An event log that cannot announce a request
const DeafLayer = AskServiceLive.pipe(
  Layer.provideMerge(refusingLog(['ask.requested'])),
  Layer.provideMerge(StoreTest),
)

const autonomous = { permissionMode: 'autonomous' } as const

it.layer(DeafLayer)('AskService with a log that cannot announce a request', (suite) => {
  suite.effect('fails the open and leaves a cancelled ask behind, never a pending one', () =>
    Effect.gen(function* withdrawsAsk() {
      yield* seedSession('open-fail-1')
      const asks = yield* AskService
      const error = yield* Effect.flip(asks.open(request('open-fail-1', autonomous)))
      const [askId = ''] = yield* askIdsOf('open-fail-1')
      assert.strictEqual(codeOf(error), 'store')
      assert.strictEqual((yield* rowOf(askId)).status, 'cancelled')
      assert.deepStrictEqual(yield* asks.pending('open-fail-1'), [])
    }),
  )

  suite.effect('fails the waiter it had parked and announces no cancellation either', () =>
    Effect.gen(function* failsParkedWaiter() {
      yield* seedSession('open-fail-2')
      const asks = yield* AskService
      yield* Effect.flip(asks.open(request('open-fail-2')))
      const [askId = ''] = yield* askIdsOf('open-fail-2')
      const error = yield* Effect.flip(asks.await(askId))
      assert.strictEqual(codeOf(error), 'not_pending')
      assert.deepStrictEqual(yield* eventsOf('open-fail-2'), [])
    }),
  )
})

// The fiber that opens an ask is interrupted while the announcement of the request is held, which is then let through
const interruptedOpening = (
  asks: AskServiceShape,
  entered: Latch.Latch,
  release: Latch.Latch,
): Effect.Effect<void> =>
  Effect.gen(function* interruptsOpening() {
    const opening = yield* Effect.forkChild(asks.open(request('open-fail-3', autonomous)))
    yield* entered.await
    const interrupting = yield* Effect.forkChild(Fiber.interrupt(opening))
    yield* release.open
    yield* Fiber.join(interrupting)
  })

it.effect('finishes opening an ask whose fiber is interrupted halfway, timer armed', () =>
  Effect.gen(function* finishesOpening() {
    const entered = yield* Latch.make()
    const release = yield* Latch.make()
    const layer = AskServiceLive.pipe(
      Layer.provideMerge(holdingLog(entered, release)),
      Layer.provideMerge(StoreTest),
    )
    const { asks, context } = yield* ownService(layer)
    yield* Effect.provide(seedSession('open-fail-3'), context)
    yield* interruptedOpening(asks, entered, release)
    yield* TestClock.adjust('30 minutes')
    yield* flush
    const [askId = ''] = yield* Effect.provide(askIdsOf('open-fail-3'), context)
    assert.strictEqual((yield* Effect.provide(rowOf(askId), context)).status, 'answered')
  }),
)
