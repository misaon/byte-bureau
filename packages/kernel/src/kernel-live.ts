import { Layer } from 'effect'
import type { SqlClient } from 'effect/sql'
import { AskServiceLive, type AskService } from './asks/ask-service.js'
import { HealthLive, type Health } from './health/health.js'
import {
  FoundationLive,
  type FoundationOptions,
  type FoundationServices,
  type UsageLayer,
} from './kernel-foundation.js'
import { PluginHostLive, type PluginHostOptions } from './plugins/plugin-host.js'
import { ProfileServiceLive, type ProfileService } from './profiles/profile-service.js'
import { ProjectRegistryLive, type ProjectRegistry } from './projects/project-registry.js'
import { SessionManagerLive, type SessionManager } from './sessions/session-manager.js'
import { WorkspaceManagerLive, type WorkspaceManager } from './workspace/workspace-manager.js'

export interface KernelLayerOptions
  extends FoundationOptions, Pick<PluginHostOptions, 'extraPlugins' | 'pluginConfig'> {
  // The environment of the kernel: a session reads its configuration with it, so BYTEBUREAU_* overrides reach a run
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

// The plugin host and the workspace runtimes its plugins bring
type PluginServices = Layer.Success<ReturnType<typeof PluginHostLive>>

export type KernelServices =
  | FoundationServices
  | ProjectRegistry
  | PluginServices
  | WorkspaceManager
  | AskService
  | ProfileService
  | SessionManager
  | Health

// The layers of the kernel; KernelTest is the only caller that passes the usage service
export const composeKernel = (
  options: KernelLayerOptions,
  usage?: UsageLayer,
): Layer.Layer<KernelServices, never, SqlClient.SqlClient> => {
  const foundation = FoundationLive(options, usage)
  const plugins = PluginHostLive({
    extraPlugins: options.extraPlugins,
    pluginConfig: options.pluginConfig,
  }).pipe(Layer.provideMerge(foundation))
  const registry = Layer.mergeAll(
    ProjectRegistryLive,
    WorkspaceManagerLive,
    AskServiceLive,
    HealthLive,
    ProfileServiceLive({ home: options.home }),
  ).pipe(Layer.provideMerge(plugins))
  return SessionManagerLive({ env: options.env }).pipe(Layer.provideMerge(registry))
}

// Everything except the store; the caller provides SqlClient (StoreLive in the binary)
export const KernelLayer = (
  options: KernelLayerOptions,
): Layer.Layer<KernelServices, never, SqlClient.SqlClient> => composeKernel(options)
