import { definePlugin } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { SqlClient, SqlError } from 'effect/sql'
import { TestClock } from 'effect/testing'
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

// The in-memory store, except that its integrity check answers as the function says
const storeWhoseCheck = (
  answer: () => Effect.Effect<unknown, SqlError.SqlError>,
): Layer.Layer<SqlClient.SqlClient> =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* answersCheck() {
      const sql = yield* SqlClient.SqlClient
      return new Proxy(sql, {
        apply: (target, self: unknown, args: unknown[]): unknown =>
          String(args[0]).includes('quick_check') ? answer() : Reflect.apply(target, self, args),
      })
    }),
  ).pipe(Layer.provide(StoreTest))

// A store whose integrity check fails as a damaged database would
const damagedStore = storeWhoseCheck(() => Effect.fail(damaged))

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

// What SQLite answers for a database whose pages disagree: a row per problem, none of them ok
const PROBLEMS = [
  { quick_check: 'row 3 missing from index sessions_status' },
  { quick_check: 'wrong # of entries in index sessions_status' },
]

const overDisagreeingStore = HealthLive.pipe(
  Layer.provide(storeWhoseCheck(() => Effect.succeed(PROBLEMS))),
  Layer.provideMerge(hostOver()),
)

it.layer(overDisagreeingStore)('Health over a store whose check finds problems', (suite) => {
  suite.effect('is degraded and names the store, though the check itself answered', () =>
    Effect.gen(function* checks() {
      yield* PluginHost.use((host) => host.load())
      const report = yield* Health.use((health) => health.check())
      assert.deepStrictEqual(report.checks.store, 'failed')
      assert.strictEqual(report.status, 'degraded')
    }),
  )
})

// The checks the store has run so far
const ran = { checks: 0 }

const overCountingStore = HealthLive.pipe(
  Layer.provide(
    storeWhoseCheck(() =>
      Effect.sync(() => {
        ran.checks += 1
        return [{ quick_check: 'ok' }]
      }),
    ),
  ),
  Layer.provideMerge(hostOver()),
)

it.layer(overCountingStore)('Health and the cost of the integrity check', (suite) => {
  suite.effect('runs the check of the store once in its time, whatever the number of probes', () =>
    Effect.gen(function* checksOnce() {
      const probe = Health.use((health) => health.check())
      yield* Effect.all([probe, probe, probe], { concurrency: 'unbounded' })
      yield* probe
      const once = ran.checks
      yield* TestClock.adjust('30 seconds')
      const report = yield* probe
      assert.deepStrictEqual([once, ran.checks, report.checks.store], [1, 2, 'ok'])
    }),
  )
})
