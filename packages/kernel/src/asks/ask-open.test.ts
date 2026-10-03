import { assert, it } from '@effect/vitest'
import { Effect, Latch } from 'effect'
import { TestClock } from 'effect/testing'
import { StoreError } from '../errors.js'
import { request } from './ask-fixtures.js'
import { announce, armTimer } from './ask-open.js'
import { parkedAsk } from './ask-open-fixtures.js'
import { codeOf, flush, rowOf, TestLayer } from './ask-service-fixtures.js'
import { awaitAnswer } from './ask-waiters.js'

const TIMEOUT = '30 minutes'

const autonomous = { permissionMode: 'autonomous' } as const

it.layer(TestLayer)('armTimer', (suite) => {
  suite.effect('expires the ask at its deadline once the request is announced', () =>
    Effect.gen(function* expiresAtDeadline() {
      const { deps, ask } = yield* parkedAsk(request('arm-1', autonomous))
      yield* armTimer(deps, ask, yield* Latch.make(true))
      yield* TestClock.adjust(TIMEOUT)
      assert.deepStrictEqual(yield* awaitAnswer(deps.waiters, ask.id), { selected: ['a'] })
    }),
  )

  suite.effect('leaves the ask alone once the timer was disarmed', () =>
    Effect.gen(function* leavesDisarmed() {
      const { deps, ask } = yield* parkedAsk(request('arm-2', autonomous))
      const disarm = yield* armTimer(deps, ask, yield* Latch.make(true))
      yield* disarm
      yield* TestClock.adjust(TIMEOUT)
      yield* flush
      assert.strictEqual((yield* rowOf(ask.id)).status, 'pending')
    }),
  )

  suite.effect('holds the expiry back until the request is announced', () =>
    Effect.gen(function* holdsBack() {
      const { deps, ask } = yield* parkedAsk(request('arm-3', autonomous))
      const announced = yield* Latch.make()
      yield* armTimer(deps, ask, announced)
      yield* TestClock.adjust(TIMEOUT)
      yield* flush
      assert.strictEqual((yield* rowOf(ask.id)).status, 'pending')
      yield* announced.open
      yield* awaitAnswer(deps.waiters, ask.id)
      assert.strictEqual((yield* rowOf(ask.id)).status, 'answered')
    }),
  )

  suite.effect('has no timer for an ask that waits, and nothing to disarm', () =>
    Effect.gen(function* hasNoTimer() {
      const { deps, ask } = yield* parkedAsk(request('arm-4'))
      const disarm = yield* armTimer(deps, ask, yield* Latch.make(true))
      yield* disarm
      yield* TestClock.adjust('10 hours')
      yield* flush
      assert.strictEqual((yield* rowOf(ask.id)).status, 'pending')
    }),
  )
})

const failing = (): Effect.Effect<never, StoreError> =>
  Effect.fail(new StoreError({ cause: 'the log is full' }))

it.layer(TestLayer)('announce', (suite) => {
  suite.effect('stops the timer and cancels the ask when the request cannot be announced', () =>
    Effect.gen(function* withdrawsOnFailure() {
      const { deps, ask } = yield* parkedAsk(request('announce-1', autonomous))
      const calls: string[] = []
      const disarm = Effect.sync(() => {
        calls.push('disarmed')
      })
      const deaf = { ...deps, log: { ...deps.log, publish: failing } }
      const error = yield* Effect.flip(announce(deaf, ask, disarm))
      assert.deepStrictEqual([codeOf(error), calls], ['store', ['disarmed']])
      assert.strictEqual((yield* rowOf(ask.id)).status, 'cancelled')
    }),
  )

  suite.effect('leaves the timer and the ask alone once the request is announced', () =>
    Effect.gen(function* keepsTimer() {
      const { deps, ask } = yield* parkedAsk(request('announce-2', autonomous))
      const calls: string[] = []
      const disarm = Effect.sync(() => {
        calls.push('disarmed')
      })
      yield* announce(deps, ask, disarm)
      assert.deepStrictEqual(calls, [])
      assert.strictEqual((yield* rowOf(ask.id)).status, 'pending')
    }),
  )
})
