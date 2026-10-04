import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { PluginHost } from '../plugins/plugin-host.js'

type Check = 'ok' | 'failed'

export interface HealthReport {
  readonly status: 'ok' | 'degraded'
  readonly checks: {
    readonly store: Check
    readonly plugins: { readonly loaded: number; readonly failed: number }
  }
}

export interface HealthShape {
  readonly check: () => Effect.Effect<HealthReport>
}

export class Health extends Context.Service<Health, HealthShape>()('bb/Health') {}

// A sound database answers quick_check with one row that says ok; anything else, or a failure to ask, is a failed store
const storeCheck = (sql: SqlClient.SqlClient): Effect.Effect<Check> =>
  sql<{ readonly quick_check: string }>`PRAGMA quick_check`.pipe(
    Effect.match({
      onFailure: (): Check => 'failed',
      onSuccess: (rows): Check =>
        rows.length === 1 && rows[0] !== undefined && rows[0].quick_check === 'ok'
          ? 'ok'
          : 'failed',
    }),
  )

const make = Effect.gen(function* makeHealth() {
  const sql = yield* SqlClient.SqlClient
  const host = yield* PluginHost
  return Health.of({
    check: () =>
      Effect.map(storeCheck(sql), (store): HealthReport => {
        const statuses = host.plugins()
        const failed = statuses.filter((plugin) => plugin.state === 'failed').length
        const plugins = { loaded: statuses.length - failed, failed }
        const status = store === 'ok' && failed === 0 ? 'ok' : 'degraded'
        return { status, checks: { store, plugins } }
      }),
  })
})

export const HealthLive: Layer.Layer<Health, never, SqlClient.SqlClient | PluginHost> =
  Layer.effect(Health, make)
