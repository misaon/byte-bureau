import { Layer } from 'effect'
import type { SqlClient } from 'effect/sql'
import { AskServiceLive, type AskService } from './asks/ask-service.js'
import {
  FoundationLive,
  type FoundationOptions,
  type FoundationServices,
  type UsageLayer,
} from './kernel-foundation.js'
import { PluginHostLive, type PluginHost, type PluginHostOptions } from './plugins/plugin-host.js'
import { ProjectRegistryLive, type ProjectRegistry } from './projects/project-registry.js'
import { SessionManagerLive, type SessionManager } from './sessions/session-manager.js'
import { StoreTest } from './store/store-test.js'
import type { WorkspaceRuntimes } from './workspace/runtimes.js'
import { WorkspaceManagerLive, type WorkspaceManager } from './workspace/workspace-manager.js'

export interface KernelLayerOptions
  extends FoundationOptions, Pick<PluginHostOptions, 'extraPlugins' | 'pluginConfig'> {}

export type KernelServices =
  | FoundationServices
  | ProjectRegistry
  | PluginHost
  | WorkspaceRuntimes
  | WorkspaceManager
  | AskService
  | SessionManager

const compose = (
  options: KernelLayerOptions,
  usage?: UsageLayer,
): Layer.Layer<KernelServices, never, SqlClient.SqlClient> => {
  const foundation = FoundationLive(options, usage)
  const plugins = PluginHostLive({
    extraPlugins: options.extraPlugins,
    pluginConfig: options.pluginConfig,
  }).pipe(Layer.provideMerge(foundation))
  const registry = Layer.mergeAll(ProjectRegistryLive, WorkspaceManagerLive, AskServiceLive).pipe(
    Layer.provideMerge(plugins),
  )
  return SessionManagerLive.pipe(Layer.provideMerge(registry))
}

// Everything except the store; the caller provides SqlClient (StoreLive in the binary, StoreTest in tests)
export const KernelLayer = (
  options: KernelLayerOptions,
): Layer.Layer<KernelServices, never, SqlClient.SqlClient> => compose(options)

// The same layers over an in-memory store; a test may swap in its own usage service
export const KernelTest = (
  options: KernelLayerOptions,
  usage?: UsageLayer,
): Layer.Layer<KernelServices | SqlClient.SqlClient> =>
  compose(options, usage).pipe(Layer.provideMerge(StoreTest))
