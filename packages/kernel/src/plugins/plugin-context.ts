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
import { toStoreError, type StoreError } from '../errors.js'
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

// The seq of the newest durable event, 0 when there is none
const latestSeq = (sql: SqlClient.SqlClient): Effect.Effect<number, StoreError> =>
  sql<{ readonly seq: number | null }>`SELECT MAX(seq) AS seq FROM events`.pipe(
    Effect.map(([row]) => (row === undefined ? null : row.seq) ?? 0),
    Effect.mapError(toStoreError),
  )

// A plugin hears what happens from the moment it subscribes: the filter of the plugin API has no since, so nothing is replayed
const eventsOf = (log: EventLogShape, sql: SqlClient.SqlClient): PluginEvents => ({
  publish: async (event) => {
    await Effect.runPromise(log.publish(event))
  },
  subscribe: (filter) => {
    const live = Effect.map(latestSeq(sql), (since) =>
      log.subscribe({ types: filter.types, sessionId: filter.sessionId, since }),
    )
    return Stream.toAsyncIterable(Stream.unwrap(live))
  },
})

// A failure of the store of a plugin names the plugin and the key
const keyed = async <Value>(
  where: { readonly plugin: string; readonly key: string },
  what: string,
  work: () => Promise<Value>,
): Promise<Value> => {
  try {
    return await work()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`plugin ${where.plugin} could not ${what} ${where.key}: ${reason}`, {
      cause: error,
    })
  }
}

// Only what JSON can hold is stored: undefined, a function or a symbol would be lost, a bigint or a cycle cannot be written
const jsonOf = (plugin: string, key: string, value: unknown): string => {
  try {
    const json: unknown = JSON.stringify(value)
    if (typeof json === 'string') {
      return json
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TypeError(`plugin ${plugin} cannot store ${key}: ${reason}`, { cause: error })
  }
  throw new TypeError(`plugin ${plugin} cannot store ${key}: a ${typeof value} is not JSON`)
}

const kvOf = (sql: SqlClient.SqlClient, plugin: string): PluginKv => ({
  get: async (key) => {
    const rows = await keyed({ plugin, key }, 'read', async () => {
      const read = await Effect.runPromise(
        sql<{
          readonly value_json: string
        }>`SELECT value_json FROM plugin_kv WHERE plugin_id = ${plugin} AND key = ${key}`,
      )
      return read
    })
    const [row] = rows
    const value: unknown =
      row === undefined
        ? undefined
        : await keyed({ plugin, key }, 'decode', async () => {
            const parsed: unknown = await Promise.resolve(JSON.parse(row.value_json))
            return parsed
          })
    return value
  },
  set: async (key, value) => {
    const json = jsonOf(plugin, key, value)
    await keyed({ plugin, key }, 'store', async () => {
      await Effect.runPromise(
        sql`INSERT INTO plugin_kv (plugin_id, key, value_json) VALUES (${plugin}, ${key}, ${json}) ON CONFLICT(plugin_id, key) DO UPDATE SET value_json = excluded.value_json`,
      )
    })
  },
  delete: async (key) => {
    await keyed({ plugin, key }, 'delete', async () => {
      await Effect.runPromise(
        sql`DELETE FROM plugin_kv WHERE plugin_id = ${plugin} AND key = ${key}`,
      )
    })
  },
})

// A plugin's own env is what it declared, so it passes the allowlist by name
// The process ends when the plugin aborts its signal or the host aborts its own, so no plugin process outlives the host
const specOf = (spec: Exec, hostSignal: AbortSignal): SpawnSpec => ({
  kind: 'helper',
  command: spec.command,
  args: spec.args,
  cwd: spec.cwd,
  env: spec.env ?? {},
  passEnv: Object.keys(spec.env ?? {}),
  signal: spec.signal === undefined ? hostSignal : AbortSignal.any([spec.signal, hostSignal]),
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

interface SpawnDeps {
  readonly supervisor: Supervisor['Service']
  readonly signal: AbortSignal
}

// The process lives in a scope of its own that closes once it has exited; the timeout is a fiber of that scope
// A timeout that is not positive sets no timer
const spawnHandle = ({ supervisor, signal }: SpawnDeps, spec: Exec): Effect.Effect<ExecHandle> =>
  Effect.gen(function* spawnsHandle() {
    const scope = yield* Scope.make()
    const spawning = supervisor.spawn(specOf(spec, signal))
    const managed = yield* Effect.provideService(spawning, Scope.Scope, scope)
    yield* Effect.forkDetach(Effect.andThen(managed.exit, Scope.close(scope, Exit.void)))
    if (spec.timeoutMs !== undefined && spec.timeoutMs > 0) {
      yield* Effect.forkIn(Effect.andThen(Effect.sleep(spec.timeoutMs), managed.kill()), scope)
    }
    return handleOf(managed)
  })

const spawnerOf = (deps: SpawnDeps): ProcessSpawner => ({
  spawn: async (spec) => {
    const handle = await Effect.runPromise(spawnHandle(deps, spec))
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
    events: eventsOf(deps.log, deps.sql),
    secrets: namespaced(deps.secrets, name),
    kv: kvOf(deps.sql, name),
    process: spawnerOf(deps),
    http: fetch,
    signal: deps.signal,
  }
}
