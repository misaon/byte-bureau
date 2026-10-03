import { PassThrough } from 'node:stream'
import { assert, it } from '@effect/vitest'
import { Effect, Fiber, Latch } from 'effect'
import { TestClock } from 'effect/testing'
import { drain } from './drain.js'

// The two pipes of a child and the latch that tells they are released
const pipes = Effect.map(Latch.make(), (closed) => ({
  stdout: new PassThrough(),
  stderr: new PassThrough(),
  closed,
}))

it.effect('destroys both pipes once two seconds pass without their release', () =>
  Effect.gen(function* destroysLingeringPipes() {
    const held = yield* pipes
    const draining = yield* Effect.forkChild(drain(held), { startImmediately: true })
    yield* TestClock.adjust('1999 millis')
    assert.deepStrictEqual([held.stdout.destroyed, held.stderr.destroyed], [false, false])
    yield* TestClock.adjust('1 millis')
    yield* Fiber.join(draining)
    assert.deepStrictEqual([held.stdout.destroyed, held.stderr.destroyed], [true, true])
  }),
)

it.effect('leaves pipes alone that were released in time', () =>
  Effect.gen(function* keepsReleasedPipes() {
    const released = yield* pipes
    yield* released.closed.open
    yield* drain(released)
    assert.deepStrictEqual([released.stdout.destroyed, released.stderr.destroyed], [false, false])
  }),
)

it.effect('has nothing to destroy for a process that never started', () =>
  Effect.gen(function* drainsNothing() {
    const closed = yield* Latch.make()
    const draining = yield* Effect.forkChild(drain({ stdout: null, stderr: null, closed }), {
      startImmediately: true,
    })
    yield* TestClock.adjust('2 seconds')
    yield* Fiber.join(draining)
  }),
)
