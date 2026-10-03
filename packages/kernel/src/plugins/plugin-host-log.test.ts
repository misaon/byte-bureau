import { assert, it } from '@effect/vitest'
import { Effect, Layer, Stream } from 'effect'
import { StoreError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { SupervisorLive } from '../process/supervisor.js'
import { StoreTest } from '../store/store-test.js'
import { BUNDLED_PLUGINS } from './bundled.js'
import { warnings } from './log-fixtures.js'
import { loadedHost, statusOf } from './plugin-fixtures.js'
import { PluginHostLive } from './plugin-host.js'

const DOWN = 'the store is down'

// A log that cannot record anything
const unreachable = Layer.succeed(
  EventLog,
  EventLog.of({
    publish: () => Effect.fail(new StoreError({ cause: DOWN })),
    subscribe: () => Stream.empty,
    read: () => Effect.succeed([]),
  }),
)

const Deps = Layer.mergeAll(unreachable, SupervisorLive).pipe(Layer.provideMerge(StoreTest))

it.layer(PluginHostLive().pipe(Layer.provideMerge(Deps)))('PluginHost without a log', (suite) => {
  suite.effect('keeps a plugin loaded when its announcement cannot be recorded, and says so', () =>
    Effect.gen(function* survivesLogFailure() {
      const records = yield* warnings
      const host = yield* loadedHost
      const unrecorded = ['plugin event not recorded', { type: 'plugin.loaded', reason: DOWN }]
      assert.strictEqual(statusOf(host, 'workspace-local').state, 'loaded')
      assert.deepStrictEqual(
        records.map((record) => [record.message[0], record.properties]),
        BUNDLED_PLUGINS.map(() => unrecorded),
      )
    }),
  )
})
