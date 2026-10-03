import { assert, describe, expect, it } from '@effect/vitest'
import { Effect, Fiber, Latch, Queue } from 'effect'
import { TestClock } from 'effect/testing'
import {
  climb,
  GRACEFUL_LADDER,
  ladderFor,
  TERMINATE_LADDER,
  type KillSignal,
} from './kill-ladder.js'

interface Sent {
  readonly signal: KillSignal
  readonly at: number
}

// Every signal is stamped with the test clock when it is sent
const recorder = Effect.gen(function* makeRecorder() {
  const clock = yield* TestClock.testClockWith(Effect.succeed)
  const sent = yield* Queue.unbounded<Sent>()
  const send = (signal: KillSignal): void => {
    Queue.offerUnsafe(sent, { signal, at: clock.currentTimeMillisUnsafe() })
  }
  return { sent, send }
})

const settle = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, { discard: true })

// One millisecond short of the grace period nothing may be sent; the last millisecond sends the next signal
const nextAfter = (sent: Queue.Dequeue<Sent>, grace: number): Effect.Effect<Sent> =>
  Effect.gen(function* waitsOutGrace() {
    yield* TestClock.adjust(grace - 1)
    yield* settle
    assert.strictEqual(yield* Queue.size(sent), 0)
    yield* TestClock.adjust(1)
    return yield* Queue.take(sent)
  })

// A process that never exits gets every rung of the ladder, one grace period apart
const climbedAgainstStubborn = (
  rungs: Parameters<typeof climb>[0],
  graces: readonly number[],
): Effect.Effect<readonly Sent[]> =>
  Effect.gen(function* climbsAll() {
    const { sent, send } = yield* recorder
    const fiber = yield* Effect.forkChild(climb(rungs, send, Effect.never), {
      startImmediately: true,
    })
    const seen = [yield* Queue.take(sent)]
    for (const grace of graces) {
      seen.push(yield* nextAfter(sent, grace))
    }
    yield* Fiber.join(fiber)
    return seen
  })

describe(climb, () => {
  it.effect('sends SIGINT, SIGTERM after 5 s and SIGKILL after another 10 s', () =>
    Effect.gen(function* climbsFully() {
      const seen = yield* climbedAgainstStubborn(GRACEFUL_LADDER, [5000, 10_000])
      assert.deepStrictEqual(seen, [
        { signal: 'SIGINT', at: 0 },
        { signal: 'SIGTERM', at: 5000 },
        { signal: 'SIGKILL', at: 15_000 },
      ])
    }),
  )

  it.effect('starts at SIGTERM on the terminating ladder', () =>
    Effect.gen(function* climbsTerminating() {
      const seen = yield* climbedAgainstStubborn(TERMINATE_LADDER, [10_000])
      assert.deepStrictEqual(seen, [
        { signal: 'SIGTERM', at: 0 },
        { signal: 'SIGKILL', at: 10_000 },
      ])
    }),
  )
})

describe('climb that has nothing left to do', () => {
  it.effect('stops climbing as soon as the process has exited', () =>
    Effect.gen(function* stopsOnExit() {
      const { sent, send } = yield* recorder
      const exited = yield* Latch.make()
      const fiber = yield* Effect.forkChild(climb(GRACEFUL_LADDER, send, exited.await), {
        startImmediately: true,
      })
      yield* Queue.take(sent)
      yield* exited.open
      yield* Fiber.join(fiber)
      yield* TestClock.adjust('1 minute')
      yield* settle
      assert.strictEqual(yield* Queue.size(sent), 0)
    }),
  )

  it.effect('sends a single requested signal and does not wait', () =>
    Effect.gen(function* sendsOnce() {
      const { sent, send } = yield* recorder
      yield* climb(ladderFor('SIGTERM'), send, Effect.never)
      yield* TestClock.adjust('1 minute')
      yield* settle
      assert.deepStrictEqual(yield* Queue.takeAll(sent), [{ signal: 'SIGTERM', at: 0 }])
    }),
  )
})

describe(ladderFor, () => {
  it('is the graceful ladder without a signal and one rung for a signal', () => {
    expect(ladderFor()).toBe(GRACEFUL_LADDER)
    expect(ladderFor('SIGKILL')).toStrictEqual([{ signal: 'SIGKILL', grace: null }])
  })
})
