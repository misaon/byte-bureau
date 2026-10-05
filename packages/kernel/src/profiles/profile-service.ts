import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { EventLog } from '../events/event-log.js'
import { PluginHost } from '../plugins/plugin-host.js'
import { Secrets } from '../secrets/secrets.js'
import { profileOperations } from './profile-operations.js'
import type { ProfileServiceShape } from './profile-types.js'

export type {
  AddProfileInput,
  Profile,
  ProfileServiceShape,
  ProfileStatus,
  ResolvedProfile,
} from './profile-types.js'

// The named auth profiles per provider: the store's profiles table is their one source of truth, their keys live in the secret store
export class ProfileService extends Context.Service<ProfileService, ProfileServiceShape>()(
  'bb/ProfileService',
) {}

export interface ProfileServiceOptions {
  // The login directories of the profiles are made under <home>/profiles
  readonly home: string
}

export const ProfileServiceLive = (
  options: ProfileServiceOptions,
): Layer.Layer<ProfileService, never, SqlClient.SqlClient | EventLog | PluginHost | Secrets> =>
  Layer.effect(
    ProfileService,
    Effect.gen(function* makesProfiles() {
      return ProfileService.of(
        profileOperations({
          sql: yield* SqlClient.SqlClient,
          log: yield* EventLog,
          host: yield* PluginHost,
          secrets: yield* Secrets,
          home: options.home,
        }),
      )
    }),
  )
