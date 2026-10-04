import type { PluginStatus } from '../plugins/plugin-host.js'
import type { AddProfileInput, Profile, ProfileStatus } from '../profiles/profile-service.js'

// What the plugins bring to the facade: their status, the agent providers they offer and the profiles those run under
export interface ProviderAreas {
  readonly profiles: {
    readonly list: () => Promise<readonly Profile[]>
    readonly get: (id: string) => Promise<Profile | undefined>
    // An unknown provider rejects with a SessionError provider_missing, as a session of it would
    readonly add: (input: AddProfileInput) => Promise<Profile>
    readonly remove: (id: string, options?: { readonly purge?: boolean }) => Promise<void>
    readonly setDefault: (id: string) => Promise<void>
    readonly status: (id: string) => Promise<ProfileStatus>
  }
  readonly providers: {
    readonly list: () => readonly {
      readonly id: string
      readonly displayName: string
      readonly supportsApiKey: boolean
    }[]
  }
  readonly plugins: { readonly list: () => readonly PluginStatus[] }
}
