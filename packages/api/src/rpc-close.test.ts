import { createServer } from 'node:http'
import { EventLog } from '@bytebureau/kernel'
import { NodeHttpServer } from '@effect/platform-node'
import { assert, it } from '@effect/vitest'
import { Effect, Layer, Stream } from 'effect'
import { serveApi } from './layer.js'
import { BootedKernel } from './testing-kernel.js'
import { createdSession } from './testing-sessions.js'
import { connected, request } from './testing-ws.js'
import { TEST_TOKEN, testOptions } from './testing.js'

// The subscriptions of the event log the API has let go of
const ended = { subscriptions: 0 }

// The event log of the kernel, whose subscriptions count themselves when they end
const CountingLog = Layer.effect(
  EventLog,
  EventLog.use((log) =>
    Effect.succeed(
      EventLog.of({
        ...log,
        subscribe: (filter) =>
          log.subscribe(filter).pipe(
            Stream.ensuring(
              Effect.sync(() => {
                ended.subscriptions += 1
              }),
            ),
          ),
      }),
    ),
  ),
)

const Watched = serveApi(testOptions()).pipe(
  Layer.provide(CountingLog),
  Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0, host: '127.0.0.1' })),
  Layer.provideMerge(BootedKernel),
)

// Waits on the live clock until the count has grown past the one given, at most a few seconds
const endedAfter = (before: number, deadline: number): Effect.Effect<boolean> =>
  Effect.suspend(() => {
    if (ended.subscriptions > before || Date.now() >= deadline) {
      return Effect.succeed(ended.subscriptions > before)
    }
    return Effect.andThen(Effect.sleep('50 millis'), endedAfter(before, deadline))
  })

// On the live clock: the end of the subscription is waited for in real time
it.layer(Watched, { excludeTestServices: true })(
  'the event subscription and its socket',
  (suite) => {
    suite.effect('ends the subscription of the event log when the socket closes', () =>
      Effect.gen(function* endsWithSocket() {
        const { session } = yield* createdSession
        const before = ended.subscriptions
        // The socket closes with this scope, once the first chunk has come, and no interrupt is sent
        yield* Effect.scoped(
          Effect.gen(function* subscribesAndCloses() {
            const client = yield* connected()
            const payload = { sessionId: session.id, since: 0 }
            client.send(request({ id: '9', tag: 'events.subscribe', payload, token: TEST_TOKEN }))
            yield* client.next
          }),
        )
        assert.isTrue(yield* endedAfter(before, Date.now() + 5000))
      }),
    )
  },
)
