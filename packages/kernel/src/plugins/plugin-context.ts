import type {
  ExecHandle,
  ExecSpec,
  PluginContext,
  PluginEvents,
  PluginKv,
  ProcessSpawner,
  SecretStore,
} from '@bytebureau/plugin-api'
import { Effect, Exit, Scope, Stream } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { EventLogShape } from '../events/event-log.js'
import { kernelLogger } from '../logging/logging.js'
import type { ManagedProcess, SpawnSpec, Supervisor } from '../process/supervisor.js'

export interface ContextDeps {
  readonly log: EventLogShape
  readonly supervisor: Supervisor['Service']
  readonly sql: SqlClient.SqlClient
  readonly secrets: SecretStore
  readonly signal: AbortSignal
}

type Exec = ExecSpec & { readonly cwd: string }

const namespaced = (secrets: SecretStore, plugin: string): SecretStore => ({
  get: async (key) => {
    const value = await secrets.get(`${plugin}/${key}`)
    return value
  },
  set: async (key, value) => {
    await secrets.set(`${plugin}/${key}`, value)
  },
  delete: async (key) => {
    await secrets.delete(`${plugin}/${key}`)
  },
})

const eventsOf = (log: EventLogShape): PluginEvents => ({
  publish: async (event) => {
    await Effect.runPromise(log.publish(event))
  },
  subscribe: (filter) =>
    Stream.toAsyncIterable(log.subscribe({ types: filter.types, sessionId: filter.sessionId })),
})

const kvOf = (sql: SqlClient.SqlClient, plugin: string): PluginKv => ({
  get: async (key) => {
    const rows = await Effect.runPromise(
      sql<{
        readonly value_json: string
      }>`SELECT value_json FROM plugin_kv WHERE plugin_id = ${plugin} AND key = ${key}`,
    )
    const [row] = rows
    const value: unknown = row === undefined ? undefined : JSON.parse(row.value_json)
    return value
  },
  set: async (key, value) => {
    await Effect.runPromise(
      sql`INSERT INTO plugin_kv (plugin_id, key, value_json) VALUES (${plugin}, ${key}, ${JSON.stringify(value)}) ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json`,
    )
  },
  delete: async (key) => {
    await Effect.runPromise(sql`DELETE FROM plugin_kv WHERE plugin_id = ${plugin} AND key = ${key}`)
  },
})

// A plugin's own env is what it declared, so it passes the allowlist by name
const specOf = (spec: Exec): SpawnSpec => ({
  kind: 'helper',
  command: spec.command,
  args: spec.args,
  cwd: spec.cwd,
  env: spec.env ?? {},
  passEnv: Object.keys(spec.env ?? {}),
  signal: spec.signal,
})

const handleOf = (managed: ManagedProcess): ExecHandle => ({
  pid: managed.pid,
  stdout: Stream.toAsyncIterable(managed.stdout),
  stderr: Stream.toAsyncIterable(managed.stderr),
  exited: Effect.runPromise(managed.exit),
  kill: (signal) => {
    Effect.runFork(managed.kill(signal))
  },
})

// The process lives in a scope of its own that closes once it has exited; the timeout is a fiber of that scope
const spawnHandle = (supervisor: Supervisor['Service'], spec: Exec): Effect.Effect<ExecHandle> =>
  Effect.gen(function* spawnsHandle() {
    const scope = yield* Scope.make()
    const managed = yield* Effect.provideService(supervisor.spawn(specOf(spec)), Scope.Scope, scope)
    yield* Effect.forkDetach(Effect.andThen(managed.exit, Scope.close(scope, Exit.void)))
    if (spec.timeoutMs !== undefined) {
      yield* Effect.forkIn(Effect.andThen(Effect.sleep(spec.timeoutMs), managed.kill()), scope)
    }
    return handleOf(managed)
  })

const spawnerOf = (supervisor: Supervisor['Service']): ProcessSpawner => ({
  spawn: async (spec) => {
    const handle = await Effect.runPromise(spawnHandle(supervisor, spec))
    return handle
  },
})

export function createPluginContext(
  name: string,
  config: unknown,
  deps: ContextDeps,
): PluginContext {
  return {
    config,
    project: null,
    logger: kernelLogger(['bb', 'plugin', name]),
    events: eventsOf(deps.log),
    secrets: namespaced(deps.secrets, name),
    kv: kvOf(deps.sql, name),
    process: spawnerOf(deps.supervisor),
    http: fetch,
    signal: deps.signal,
  }
}
