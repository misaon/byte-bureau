import { Layer } from 'effect'
import { AskServiceLive } from '../asks/ask-service.js'
import { PluginHostLive, type PluginHostOptions } from '../plugins/plugin-host.js'
import { SupervisorLive } from '../process/supervisor.js'
import { TestLayer as RegistryLayer } from '../projects/project-registry-fixtures.js'
import { UsageServiceLive } from '../usage/usage-service.js'
import { WorkspaceManagerLive } from '../workspace/workspace-manager.js'
import { SessionManagerLive } from './session-manager.js'
import type { SessionServices } from './session-services.js'

// The session layer over the real bundled plugins (the local worktrees and the fake agent) and an in-memory store
// Task 14's KernelTest composes the same services and supersedes it
export const sessionLayer = (
  options: PluginHostOptions = {},
  usage: typeof UsageServiceLive = UsageServiceLive,
): Layer.Layer<SessionServices> => {
  const plugins = PluginHostLive(options).pipe(
    Layer.provideMerge(SupervisorLive),
    Layer.provideMerge(RegistryLayer),
  )
  const services = Layer.mergeAll(WorkspaceManagerLive, AskServiceLive, usage).pipe(
    Layer.provideMerge(plugins),
  )
  return SessionManagerLive.pipe(Layer.provideMerge(services))
}

// The same layer with more plugins, such as an agent a test drives, and the usage service a test wants
export const withPlugins = (
  plugins: NonNullable<PluginHostOptions['extraPlugins']>,
  usage?: typeof UsageServiceLive,
): Layer.Layer<SessionServices> => sessionLayer({ extraPlugins: plugins }, usage)
