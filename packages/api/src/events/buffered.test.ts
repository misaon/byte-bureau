import type { EventEnvelope } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Latch, Logger, References, Stream } from 'effect'
import { buffered } from './buffered.js'

const event = (seq: number, id: string): EventEnvelope => ({
  seq,
  id,
  ts: '2026-10-04T00:00:00.000Z',
  type: seq === 0 ? 'message.assistant.delta' : 'turn.started',
  payload: {},
})

const idsOf = (events: readonly EventEnvelope[]): string[] => events.map((item) => item.id)

interface LogLine {
  readonly level: string
  readonly category: unknown
}

it.effect('hands on the events of its source in their order and ends with the source', () =>
  Effect.gen(function* passesOn() {
    const source = Stream.make(event(1, 'a'), event(0, 'd1'), event(2, 'b'))
    const read = yield* Stream.runCollect(buffered(source))
    assert.deepStrictEqual(idsOf(read), ['a', 'd1', 'b'])
  }),
)

it.effect('drops the oldest ephemeral events a reader has not taken, and no durable one', () =>
  Effect.gen(function* outruns() {
    // A source that gives all its events in one go is read to the end before the reader runs
    const events = [event(1, 'a'), event(0, 'd1'), event(0, 'd2'), event(0, 'd3'), event(2, 'b')]
    const read = yield* Stream.runCollect(
      buffered(Stream.fromIterable(events), { capacity: 2, durable: 100 }),
    )
    assert.deepStrictEqual(idsOf(read), ['a', 'd2', 'd3', 'b'])
  }),
)

it.effect('ends instead of failing when its source fails, and logs the failure under bb.api', () =>
  Effect.gen(function* survives() {
    const lines: LogLine[] = []
    const logger = Logger.make((options) => {
      const { category } = options.fiber.getRef(References.CurrentLogAnnotations)
      lines.push({ level: options.logLevel, category })
    })
    const failure = Stream.fail(new Error('gone'))
    const source = Stream.make(event(1, 'a')).pipe(Stream.concat(failure))
    const logging = Logger.layer([logger])
    const read = yield* Stream.runCollect(buffered(source)).pipe(Effect.provide(logging))
    assert.deepStrictEqual(idsOf(read), ['a'])
    assert.deepStrictEqual(lines, [{ level: 'Warn', category: 'bb.api' }])
  }),
)

it.effect('stops reading its source once the reader is gone', () =>
  Effect.gen(function* stops() {
    const stopped = yield* Latch.make()
    const source = Stream.make(event(1, 'a')).pipe(
      Stream.concat(Stream.never),
      Stream.ensuring(stopped.open),
    )
    const firstOnly = buffered(source).pipe(Stream.take(1))
    const read = yield* Stream.runCollect(firstOnly)
    assert.deepStrictEqual(idsOf(read), ['a'])
    assert.isTrue(Latch.isOpen(stopped))
  }),
)

it.effect(
  'lets go of a reader that lags too far behind: the stream ends after what waits, with a warning',
  () =>
    Effect.gen(function* letsGo() {
      const lines: LogLine[] = []
      const logger = Logger.make((options) => {
        const { category } = options.fiber.getRef(References.CurrentLogAnnotations)
        lines.push({ level: options.logLevel, category })
      })
      // A source that never ends on its own: only the bound ends the stream
      const events = [event(1, 'a'), event(2, 'b'), event(3, 'c'), event(4, 'd')]
      const source = Stream.fromIterable(events).pipe(Stream.concat(Stream.never))
      const read = yield* Stream.runCollect(buffered(source, { capacity: 2, durable: 2 })).pipe(
        Effect.provide(Logger.layer([logger])),
      )
      assert.deepStrictEqual(idsOf(read), ['a', 'b', 'c'])
      assert.deepStrictEqual(lines, [{ level: 'Warn', category: 'bb.api' }])
    }),
)

it.effect('tells at debug level how many ephemeral events a slow reader lost', () =>
  Effect.gen(function* tellsLost() {
    const lines: LogLine[] = []
    const logger = Logger.make((options) => {
      const { category } = options.fiber.getRef(References.CurrentLogAnnotations)
      lines.push({ level: options.logLevel, category })
    })
    const events = [event(0, 'd1'), event(0, 'd2'), event(0, 'd3')]
    yield* Stream.runCollect(
      buffered(Stream.fromIterable(events), { capacity: 1, durable: 10 }),
    ).pipe(
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(References.MinimumLogLevel, 'Debug'),
    )
    assert.deepStrictEqual(lines, [{ level: 'Debug', category: 'bb.api' }])
  }),
)
