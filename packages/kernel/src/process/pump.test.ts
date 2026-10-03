import { PassThrough } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { assert, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import { startPump } from './pump.js'

// Lets the event loop run, so what was written reaches the reader
const turn = Effect.promise(async () => {
  await nextTurn()
})

// The input has ended for good: every chunk has been through the reader by now
const closed = (input: PassThrough): Effect.Effect<void> =>
  Effect.callback((resume) => {
    input.once('close', () => {
      resume(Effect.void)
    })
  })

it.effect('queues the lines that arrive before anybody reads the stream', () =>
  Effect.gen(function* queuesEarlyLines() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 10)
    input.end('early\nlines\n')
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['early', 'lines'])
  }),
)

it.effect('splits CRLF and keeps an unterminated last line', () =>
  Effect.gen(function* splitsLines() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 10)
    input.end('one\r\ntwo\nthree')
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['one', 'two', 'three'])
    assert.deepStrictEqual(pump.recent(), ['one', 'two', 'three'])
  }),
)

it.effect('keeps the newest lines for diagnostics while the stream carries every line', () =>
  Effect.gen(function* boundsRecent() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 2)
    input.end('a\nb\nc\nd\n')
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(pump.recent(), ['c', 'd'])
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['a', 'b', 'c', 'd'])
  }),
)

it.effect('appends a line that did not come from the input', () =>
  Effect.gen(function* appendsLine() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 5)
    pump.append('spawn failed')
    input.end()
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['spawn failed'])
    assert.deepStrictEqual(pump.recent(), ['spawn failed'])
  }),
)

it.effect('ends without a line when there is no input at all', () =>
  Effect.gen(function* endsWithoutInput() {
    const pump = yield* startPump(null, 5)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), [])
    assert.deepStrictEqual(pump.recent(), [])
  }),
)

it.effect('closes an input that never signals its end', () =>
  Effect.gen(function* closesOpenInput() {
    const input = new PassThrough()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        input.destroy()
      }),
    )
    const pump = yield* startPump(input, 5)
    yield* pump.finish
    input.write('late\n')
    yield* turn
    assert.deepStrictEqual(pump.recent(), [])
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), [])
  }),
)

it.effect('keeps what was read and ends the stream when the input fails', () =>
  Effect.gen(function* survivesBrokenInput() {
    const input = new PassThrough()
    const pump = yield* startPump(input, 5)
    input.write('kept\n')
    yield* turn
    input.destroy(new Error('broken pipe'))
    yield* closed(input)
    yield* pump.finish
    assert.deepStrictEqual(yield* Stream.runCollect(pump.lines), ['kept'])
  }),
)
