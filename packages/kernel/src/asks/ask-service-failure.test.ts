import { assert, it } from '@effect/vitest'
import { Effect, Fiber, Layer } from 'effect'
import { StoreError } from '../errors.js'
import { EventLog, EventLogLive } from '../events/event-log.js'
import { StoreTest } from '../store/store-test.js'
import { request } from './ask-fixtures.js'
import { AskService, AskServiceLive } from './ask-service.js'
import { codeOf, rowOf, seedSession } from './ask-service-fixtures.js'

// An event log that records everything but how an ask ended
const ForgetfulLog = Layer.effect(
  EventLog,
  Effect.gen(function* makesForgetfulLog() {
    const log = yield* EventLog
    return EventLog.of({
      ...log,
      publish: (event) =>
        event.type === 'ask.answered' || event.type === 'ask.cancelled'
          ? Effect.fail(new StoreError({ cause: 'the log is full' }))
          : log.publish(event),
    })
  }),
).pipe(Layer.provide(EventLogLive))

const FailingLayer = AskServiceLive.pipe(
  Layer.provideMerge(ForgetfulLog),
  Layer.provideMerge(StoreTest),
)

it.layer(FailingLayer)('AskService with a log that fails', (suite) => {
  suite.effect('still hands an answer the log could not record to the caller that waits', () =>
    Effect.gen(function* answersDespiteLog() {
      yield* seedSession('fail-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('fail-1'))
      const waiting = yield* Effect.forkChild(asks.await(ask.id))
      const error = yield* Effect.flip(asks.answer(ask.id, { selected: ['b'] }, 'cli'))
      assert.strictEqual(codeOf(error), 'store')
      assert.deepStrictEqual(yield* Fiber.join(waiting), { selected: ['b'] })
      assert.strictEqual((yield* rowOf(ask.id)).status, 'answered')
    }),
  )

  suite.effect('still fails the caller that waits when the cancellation was not recorded', () =>
    Effect.gen(function* cancelsDespiteLog() {
      yield* seedSession('fail-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('fail-2'))
      const waiting = yield* Effect.forkChild(Effect.flip(asks.await(ask.id)))
      const error = yield* Effect.flip(asks.cancel(ask.id))
      assert.strictEqual(codeOf(error), 'store')
      assert.strictEqual(codeOf(yield* Fiber.join(waiting)), 'not_pending')
      assert.strictEqual((yield* rowOf(ask.id)).status, 'cancelled')
    }),
  )
})
