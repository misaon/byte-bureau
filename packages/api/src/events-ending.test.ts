import { createServer } from 'node:http'
import { EventLog, StoreError } from '@bytebureau/kernel'
import type { EventEnvelope } from '@bytebureau/protocol'
import { NodeHttpServer } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import { Effect, Layer, Logger, References, Stream } from 'effect'
import { serveApi } from './layer.js'
import { testOptions, type ApiTestLayer } from './testing.js'
import { BootedKernel } from './testing-kernel.js'
import { framesUntil, opened, seqNumbersOf } from './testing-sse.js'

const envelope = (seq: number): EventEnvelope => ({
  seq,
  id: `e${seq}`,
  ts: '2026-10-04T00:00:00.000Z',
  type: 'turn.started',
  payload: {},
})

interface LogLine {
  readonly level: string
  readonly category: unknown
}

// A logger of its own for each suite, and the lines it has been given: the level and the category (the listening lines among them)
const collecting = (): { logger: Logger.Logger<unknown, void>; lines: LogLine[] } => {
  const lines: LogLine[] = []
  const logger = Logger.make((options) => {
    const { category } = options.fiber.getRef(References.CurrentLogAnnotations)
    lines.push({ level: options.logLevel, category })
  })
  return { logger, lines }
}

const warningsOf = (lines: readonly LogLine[]): LogLine[] =>
  lines.filter((line) => line.level === 'Warn')

// The API over a log whose subscription is the one given; the logger sits next to the API, where its requests see it
const over = (
  subscription: Stream.Stream<EventEnvelope, StoreError>,
  logger: Logger.Logger<unknown, void>,
): ReturnType<typeof ApiTestLayer> => {
  const log = Layer.succeed(
    EventLog,
    EventLog.of({
      publish: () => Effect.die('the stream publishes nothing'),
      read: () => Effect.die('the stream reads only through its subscription'),
      subscribe: () => subscription,
    }),
  )
  return serveApi(testOptions({ heartbeat: '100 millis' })).pipe(
    Layer.provide(Logger.layer([logger])),
    Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: '127.0.0.1' })),
    Layer.provideMerge(log),
    Layer.provideMerge(BootedKernel),
  )
}

// The frames of the whole response, which has to end by itself
const wholeStream = Effect.gen(function* reads() {
  const response = yield* opened()
  return yield* framesUntil(response, () => false).pipe(Effect.timeout('5 seconds'))
})

const live = { excludeTestServices: true }

const ended = collecting()
const endingSubscription = Stream.make(envelope(1), envelope(2))

it.layer(over(endingSubscription, ended.logger), live)(
  'GET /api/v1/events when the subscription ends',
  (suite) => {
    suite.effect('ends the response with it, after the events it gave, without a word', () =>
      Effect.gen(function* ends() {
        assert.deepStrictEqual(seqNumbersOf(yield* wholeStream), [1, 2])
        assert.deepStrictEqual(warningsOf(ended.lines), [])
      }),
    )
  },
)

const failed = collecting()
const gone = new StoreError({ cause: new Error('the store is gone') })
const failingSubscription = Stream.make(envelope(1)).pipe(Stream.concat(Stream.fail(gone)))

it.layer(over(failingSubscription, failed.logger), live)(
  'GET /api/v1/events when the subscription fails',
  (suite) => {
    suite.effect('ends the response after the events it gave, and logs the failure', () =>
      Effect.gen(function* fails() {
        assert.deepStrictEqual(seqNumbersOf(yield* wholeStream), [1])
        assert.deepStrictEqual(warningsOf(failed.lines), [{ level: 'Warn', category: 'bb.api' }])
      }),
    )
  },
)
