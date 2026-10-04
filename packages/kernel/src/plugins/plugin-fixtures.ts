import {
  definePlugin,
  type AgentCapabilities,
  type AgentProvider,
  type Plugin,
  type PluginContext,
  type PluginManifest,
  type PluginRegistration,
  type WorkspaceRuntime,
} from '@bytebureau/plugin-api'
import { Context, Effect, Exit, Layer, Scope } from 'effect'
import type { SqlClient } from 'effect/sql'
import { EventLogLive, type EventLog } from '../events/event-log.js'
import { SupervisorLive, type Supervisor } from '../process/supervisor.js'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import { Secrets } from '../secrets/secrets.js'
import { StoreTest } from '../store/store-test.js'
import type { WorkspaceRuntimes } from '../workspace/runtimes.js'
import {
  PluginHost,
  PluginHostLive,
  type PluginHostOptions,
  type PluginHostShape,
  type PluginStatus,
} from './plugin-host.js'

const NO_CAPABILITIES: AgentCapabilities = {
  resume: false,
  interrupt: false,
  askUser: false,
  permissions: false,
  structuredOutput: false,
  usage: false,
  rateLimits: false,
  contextUsage: false,
  thinking: false,
  setModel: false,
  setEffort: false,
  attachments: false,
}

type Dependencies = EventLog | Supervisor | SqlClient.SqlClient | Secrets

// Secrets in memory, a store of its own for each build of a layer
export const SecretsInMemory: Layer.Layer<Secrets> = Layer.sync(
  Secrets,
  () => new InMemorySecretStore(),
)

// The event log and the supervisor over an in-memory store, and secrets in memory
const Deps: Layer.Layer<Dependencies> = Layer.mergeAll(
  EventLogLive,
  SupervisorLive,
  SecretsInMemory,
).pipe(Layer.provideMerge(StoreTest))

// The host over those dependencies, which stay in reach of a test beside it
export const hostOver = (
  options: PluginHostOptions = {},
): Layer.Layer<PluginHost | WorkspaceRuntimes | Dependencies> =>
  PluginHostLive(options).pipe(Layer.provideMerge(Deps))

// The host with its plugins loaded; loading twice is harmless
export const loadedHost: Effect.Effect<PluginHostShape, never, PluginHost> = Effect.gen(
  function* loadsHost() {
    const host = yield* PluginHost
    yield* host.load()
    return host
  },
)

export const manifestOf = (name: string, extra: Partial<PluginManifest> = {}): PluginManifest => ({
  name,
  version: '1.0.0',
  hostApi: '^0',
  kind: 'in-process',
  ...extra,
})

const unused = async (): Promise<never> => {
  await Promise.resolve()
  throw new Error('a stub does nothing')
}

// A provider that offers nothing and never opens a session
export const providerOf = (id: string): AgentProvider => ({
  id,
  displayName: id,
  capabilities: NO_CAPABILITIES,
  authStatus: async () => {
    const state = await Promise.resolve('loggedIn' as const)
    return { state }
  },
  createSession: unused,
})

// A runtime that offers nothing
export const runtimeOf = (id: string): WorkspaceRuntime => ({
  id,
  isolation: 'none',
  provision: unused,
  exec: unused,
  status: unused,
  destroy: unused,
})

// A hook that passes everything on as it is
export const passOn = async <Input, Result>(
  input: Readonly<Input>,
  proceed: (input: Input) => Promise<Result>,
): Promise<Result> => {
  const result = await proceed(input)
  return result
}

// A hook that notes its name in the journal and passes on
export const noting =
  (journal: string[], name: string) =>
  async <Input, Result>(
    input: Readonly<Input>,
    proceed: (input: Input) => Promise<Result>,
  ): Promise<Result> => {
    journal.push(name)
    const result = await proceed(input)
    return result
  }

export interface Probe {
  readonly plugin: Plugin
  // The context the host handed over in setup; asking before the plugin has loaded fails
  readonly context: () => PluginContext
}

// A plugin that registers what it is given and keeps its context, for tests that call the context
export function probe(
  name: string,
  registration: PluginRegistration = {},
  manifest: Partial<PluginManifest> = {},
): Probe {
  const kept: { context?: PluginContext } = {}
  const plugin = definePlugin({
    manifest: manifestOf(name, manifest),
    setup: (context) => {
      kept.context = context
      return registration
    },
  })
  return {
    plugin,
    context: () => {
      if (kept.context === undefined) {
        throw new Error(`plugin ${name} has not been set up`)
      }
      return kept.context
    },
  }
}

export function statusOf(
  host: { readonly plugins: () => readonly PluginStatus[] },
  name: string,
): PluginStatus {
  const status = host.plugins().find((candidate) => candidate.name === name)
  if (status === undefined) {
    throw new Error(`no status for plugin ${name}`)
  }
  return status
}

// A host of its own, which the test shuts down itself; the scope closes it with the test at the latest
export const startHost = (
  options: PluginHostOptions = {},
): Effect.Effect<
  { readonly host: PluginHostShape; readonly stop: Effect.Effect<void> },
  never,
  Scope.Scope
> =>
  Effect.gen(function* startsHost() {
    const scope = yield* Effect.acquireRelease(Scope.make(), (own) => Scope.close(own, Exit.void))
    const context = yield* Layer.buildWithScope(hostOver(options), scope)
    return { host: Context.get(context, PluginHost), stop: Scope.close(scope, Exit.void) }
  })
