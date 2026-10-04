import { Context } from 'effect'
import { PluginHost } from '../plugins/plugin-host.js'
import type { Promised, Services } from './promised.js'
import type { Kernel } from './types.js'

// A plugin that fails to load is reported by the host and does not stop the kernel
export async function loadPlugins(promised: Promised): Promise<void> {
  await promised(PluginHost, (host) => host.load())()
}

// What the host made of each plugin, read without a promise like the providers
export const pluginsApi = (services: Context.Context<Services>): Kernel['plugins'] => ({
  list: () => Context.get(services, PluginHost).plugins(),
})

export const providersApi = (services: Context.Context<Services>): Kernel['providers'] => ({
  list: () =>
    Context.get(services, PluginHost)
      .agentProviders()
      .map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        supportsApiKey: provider.apiKeyEnv !== undefined,
      })),
})
