import { assert, it } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import { awaitAnswer, closeWaiters, park, wake, type Waiters } from './ask-waiters.js'

it.effect('looks for the waiter when the wait is run, not when it is built', () =>
  Effect.gen(function* looksLate() {
    const waiters: Waiters = new Map()
    const waiting = awaitAnswer(waiters, 'ask-1')
    yield* park(waiters, 'ask-1')
    yield* wake(waiters, 'ask-1', Exit.succeed({ selected: ['x'] }))
    assert.deepStrictEqual(yield* waiting, { selected: ['x'] })
  }),
)

it.effect('fails a wait nobody parked a waiter for', () =>
  Effect.gen(function* failsStranger() {
    const error = yield* Effect.flip(awaitAnswer(new Map(), 'nobody'))
    assert.deepStrictEqual(
      [error.code, error.reason],
      ['not_found', 'ask nobody was not opened by this process'],
    )
  }),
)

it.effect('fails every waiter that is not done when the service closes and keeps the others', () =>
  Effect.gen(function* closesWaiters() {
    const waiters: Waiters = new Map()
    yield* Effect.all([park(waiters, 'done'), park(waiters, 'open')])
    yield* wake(waiters, 'done', Exit.succeed({ selected: ['x'] }))
    yield* closeWaiters(waiters)
    assert.deepStrictEqual(yield* awaitAnswer(waiters, 'done'), { selected: ['x'] })
    const error = yield* Effect.flip(awaitAnswer(waiters, 'open'))
    assert.deepStrictEqual([error.code, error.reason], ['not_pending', 'service closed'])
  }),
)
