import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { request } from './ask-fixtures.js'
import { logged } from './ask-log-fixtures.js'
import { codeOf, flush, ownService, reasonOf, seedSession } from './ask-service-fixtures.js'

it.effect('leaves no timer running once its layer is released', () =>
  Effect.gen(function* stopsTimers() {
    const records = yield* logged
    const { asks, context, close } = yield* ownService()
    const opening = Effect.andThen(
      seedSession('close-1'),
      asks.open(request('close-1', { permissionMode: 'autonomous' })),
    )
    yield* Effect.provide(opening, context)
    yield* close
    yield* TestClock.adjust('30 minutes')
    yield* flush
    assert.deepStrictEqual(records, [])
  }),
)

it.effect('fails a caller that still waits when its layer is released', () =>
  Effect.gen(function* failsWaiters() {
    const { asks, context, close } = yield* ownService()
    yield* Effect.provide(seedSession('close-2'), context)
    const ask = yield* asks.open(request('close-2'))
    const waiting = yield* Effect.forkChild(Effect.flip(asks.await(ask.id)))
    yield* flush
    yield* close
    const error = yield* Fiber.join(waiting)
    assert.deepStrictEqual([codeOf(error), reasonOf(error)], ['not_pending', 'service closed'])
    const late = yield* Effect.flip(asks.await(ask.id))
    assert.strictEqual(codeOf(late), 'not_pending')
  }),
)

it.effect('keeps the answer of an ask that was settled before its layer was released', () =>
  Effect.gen(function* keepsAnswer() {
    const { asks, context, close } = yield* ownService()
    yield* Effect.provide(seedSession('close-3'), context)
    const ask = yield* asks.open(request('close-3'))
    yield* asks.answer(ask.id, { selected: ['b'] }, 'cli')
    yield* close
    assert.deepStrictEqual(yield* asks.await(ask.id), { selected: ['b'] })
  }),
)
