import type { AgentProvider } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import { SessionError } from '../errors.js'
import type { PluginHostShape } from '../plugins/plugin-host.js'

// A provider that is not there is refused with the ones that are
export const requireProvider = (
  host: PluginHostShape,
  providerId: string,
): Effect.Effect<AgentProvider, SessionError> => {
  const provider = host.agentProvider(providerId)
  if (provider !== undefined) {
    return Effect.succeed(provider)
  }
  const available = host
    .agentProviders()
    .map((candidate) => candidate.id)
    .join(', ')
  return Effect.fail(
    new SessionError({
      code: 'provider_missing',
      reason: `provider "${providerId}" is not available; available: ${available}`,
    }),
  )
}
