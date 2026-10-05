import { PluginHost } from '@bytebureau/kernel'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'

export const PluginsHandlers = HttpApiBuilder.group(BureauApi, 'plugins', (handlers) =>
  handlers
    .handle('list', () => PluginHost.useSync((host) => host.plugins()))
    .handle('providers', () =>
      PluginHost.useSync((host) =>
        host.agentProviders().map((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          supportsApiKey: provider.apiKeyEnv !== undefined,
        })),
      ),
    ),
)
