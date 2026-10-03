import type { AgentProvider, Plugin, SecretStore, WorkspaceRuntime } from '@bytebureau/plugin-api'
import { Context, Effect, Layer, type Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { EventLog } from '../events/event-log.js'
import { Supervisor } from '../process/supervisor.js'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import { WorkspaceRuntimes, type WorkspaceRuntimesShape } from '../workspace/runtimes.js'
import { BUNDLED_PLUGINS } from './bundled.js'
import type { HookBus } from './hooks.js'
import { PluginLoader, type PluginStatus } from './plugin-loader.js'

export type { PluginStatus } from './plugin-loader.js'

export interface PluginHostShape {
  // Loads the bundled plugins and then the extra ones; the first call does the work, later ones wait for it
  readonly load: () => Effect.Effect<void>
  readonly plugins: () => readonly PluginStatus[]
  readonly agentProviders: () => readonly AgentProvider[]
  readonly agentProvider: (id: string) => AgentProvider | undefined
  readonly workspaceRuntimes: () => readonly WorkspaceRuntime[]
  readonly hooks: HookBus
}

export interface PluginHostOptions {
  readonly extraPlugins?: readonly Plugin[] | undefined
  readonly pluginConfig?: Readonly<Record<string, unknown>> | undefined
  readonly secrets?: SecretStore | undefined
}

export class PluginHost extends Context.Service<PluginHost, PluginHostShape>()('bb/PluginHost') {}

const hostOf = (loader: PluginLoader, load: Effect.Effect<void>): PluginHostShape => ({
  load: () => load,
  plugins: () => loader.plugins(),
  agentProviders: () => loader.ports.agentProviders(),
  agentProvider: (id) => loader.ports.agentProvider(id),
  workspaceRuntimes: () => loader.ports.workspaceRuntimes(),
  hooks: loader.hooks,
})

const runtimesOf = (loader: PluginLoader): WorkspaceRuntimesShape => ({
  get: (id) => loader.ports.workspaceRuntime(id),
  list: () => loader.ports.workspaceRuntimes(),
})

interface Assembled {
  readonly host: PluginHostShape
  readonly runtimes: WorkspaceRuntimesShape
}

// At release the plugins' signal aborts first, then they are disposed
const make = (
  options: PluginHostOptions,
): Effect.Effect<Assembled, never, EventLog | Supervisor | SqlClient.SqlClient | Scope.Scope> =>
  Effect.gen(function* makePluginHost() {
    const log = yield* EventLog
    const supervisor = yield* Supervisor
    const sql = yield* SqlClient.SqlClient
    const controller = new AbortController()
    const secrets = options.secrets ?? new InMemorySecretStore()
    const deps = { log, supervisor, sql, secrets, signal: controller.signal }
    const loader = new PluginLoader(deps, options.pluginConfig ?? {})
    const load = yield* Effect.cached(
      loader.load([...BUNDLED_PLUGINS, ...(options.extraPlugins ?? [])]),
    )
    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        Effect.sync(() => {
          controller.abort()
        }),
        loader.dispose(),
      ),
    )
    return { host: hostOf(loader, load), runtimes: runtimesOf(loader) }
  })

export const PluginHostLive = (
  options: PluginHostOptions = {},
): Layer.Layer<
  PluginHost | WorkspaceRuntimes,
  never,
  EventLog | Supervisor | SqlClient.SqlClient
> =>
  Layer.unwrap(
    Effect.map(make(options), ({ host, runtimes }) =>
      Layer.mergeAll(
        Layer.succeed(PluginHost, PluginHost.of(host)),
        Layer.succeed(WorkspaceRuntimes, WorkspaceRuntimes.of(runtimes)),
      ),
    ),
  )
