import type { ProfileRef } from '@bytebureau/plugin-api'
import type { AuthState } from '@bytebureau/protocol'
import type { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { ProfileError, SessionError, StoreError } from '../errors.js'
import type { EventLogShape } from '../events/event-log.js'
import type { PluginHostShape } from '../plugins/plugin-host.js'
import type { SecretsShape } from '../secrets/secrets.js'

export interface Profile {
  readonly id: string
  readonly providerId: string
  readonly name: string
  readonly kind: 'login' | 'api_key'
  readonly configDir: string | null
  readonly isDefault: boolean
  readonly createdAt: string
}

export interface AddProfileInput {
  readonly providerId: string
  readonly name: string
  readonly kind: 'login' | 'api_key'
  readonly apiKey?: string | undefined
  readonly makeDefault?: boolean | undefined
}

// The optional fields are left out rather than undefined, as the API's ProfileStatusDto has them
export interface ProfileStatus {
  readonly profileId: string
  readonly state: AuthState
  readonly hint?: string
  readonly account?: string
  readonly checkedAt: string
}

// The key of an api_key profile travels in the variable the provider declared; a login profile is its ref alone
export interface ResolvedProfile {
  readonly ref: ProfileRef
  readonly apiKey?: { readonly env: string; readonly value: string } | undefined
}

export interface Removal {
  // The login directory goes as well; without it a profile added again under the name finds its login
  readonly purge?: boolean
}

// What the operations of the service work with
export interface ProfileDeps {
  readonly sql: SqlClient.SqlClient
  readonly log: EventLogShape
  readonly host: PluginHostShape
  readonly secrets: SecretsShape
  readonly home: string
}

export interface ProfileServiceShape {
  readonly list: () => Effect.Effect<readonly Profile[], StoreError>
  readonly get: (id: string) => Effect.Effect<Profile | undefined, StoreError>
  // An unknown provider is refused as a session would be, with SessionError provider_missing
  readonly add: (
    input: AddProfileInput,
  ) => Effect.Effect<Profile, ProfileError | SessionError | StoreError>
  readonly remove: (id: string, removal?: Removal) => Effect.Effect<void, ProfileError | StoreError>
  readonly setDefault: (id: string) => Effect.Effect<void, ProfileError | StoreError>
  readonly status: (id: string) => Effect.Effect<ProfileStatus, ProfileError | StoreError>
  // The profile a session of the provider runs under: the one named, else the default, else the nameless login
  readonly resolve: (
    providerId: string,
    profileId: string | null | undefined,
  ) => Effect.Effect<ResolvedProfile, ProfileError | StoreError>
}
