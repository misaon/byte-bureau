import { definePlugin } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { SqlClient, SqlError } from 'effect/sql'
import { hostOver } from '../plugins/plugin-fixtures.js'
import { PluginHost } from '../plugins/plugin-host.js'
import { sessionLayer, withPlugins } from '../sessions/session-layer-fixtures.js'
import { StoreTest } from '../store/store-test.js'
import { Health, HealthLive } from './health.js'

const broken = definePlugin({
  manifest: { name: 'broken', version: '0.0.0', hostApi: '^0.0.0', kind: 'in-process' },
  setup: () => {
    throw new Error('no setup today')
  },
})

const damaged = new SqlError.SqlError({
  reason: new SqlError.UnknownError({
    cause: 'damaged',
    message: 'database disk image is malformed',
    operation: 'quick_check',
  }),
})

// The in-memory store, except that its integrity check fails as a damaged database would
const damagedStore = Layer.effect(
  SqlClient.SqlClient,
  Effect.gen(function* damagesStore() {
    const sql = yield* SqlClient.SqlClient
    return new Proxy(sql, {
      apply: (target, self: unknown, args: unknown[]): unknown =>
        String(args[0]).includes('quick_check')
          ? Effect.fail(damaged)
          : Reflect.apply(target, self, args),
    })
  }),
).pipe(Layer.provide(StoreTest))

it.layer(sessionLayer())('Health over a sound kernel', (suite) => {
  suite.effect('is ok and counts the bundled plugins', () =>
    Effect.gen(function* checks() {
      yield* PluginHost.use((host) => host.load())
      const report = yield* Health.use((health) => health.check())
      assert.deepStrictEqual(report, {
        status: 'ok',
        checks: { store: 'ok', plugins: { loaded: 2, failed: 0 } },
      })
    }),
  )
})

it.layer(withPlugins([broken]))('Health over a kernel with a failed plugin', (suite) => {
  suite.effect('is degraded and counts the failure', () =>
    Effect.gen(function* checks() {
      yield* PluginHost.use((host) => host.load())
      const report = yield* Health.use((health) => health.check())
      assert.deepStrictEqual(report, {
        status: 'degraded',
        checks: { store: 'ok', plugins: { loaded: 2, failed: 1 } },
      })
    }),
  )
})

// The health of that store beside the plugin host of a sound one
const overDamagedStore = HealthLive.pipe(
  Layer.provide(damagedStore),
  Layer.provideMerge(hostOver()),
)

it.layer(overDamagedStore)('Health over a store that fails its check', (suite) => {
  suite.effect('is degraded and names the store', () =>
    Effect.gen(function* checks() {
      yield* PluginHost.use((host) => host.load())
      const report = yield* Health.use((health) => health.check())
      assert.deepStrictEqual(report, {
        status: 'degraded',
        checks: { store: 'failed', plugins: { loaded: 2, failed: 0 } },
      })
    }),
  )
})
