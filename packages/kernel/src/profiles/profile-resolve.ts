import { Effect } from 'effect'
import { ProfileError, type StoreError } from '../errors.js'
import { namelessRefOf } from './profile-ids.js'
import { lostKeyReason, usableKeyOf } from './profile-keys.js'
import { defaultProfileOf, requireProfile } from './profile-records.js'
import { refOf } from './profile-status.js'
import type { Profile, ProfileDeps, ResolvedProfile } from './profile-types.js'

const invalid = (reason: string): ProfileError => new ProfileError({ code: 'invalid', reason })

// The variable the provider of the profile takes a key in; a provider that is gone, or took it back, takes none
const keyEnvOf = (deps: ProfileDeps, profile: Profile): Effect.Effect<string, ProfileError> => {
  const provider = deps.host.agentProvider(profile.providerId)
  const env = provider === undefined ? undefined : provider.apiKeyEnv
  return env === undefined
    ? Effect.fail(invalid(`provider "${profile.providerId}" takes no API-key profile`))
    : Effect.succeed(env)
}

// The key of an api_key profile; one the secret store no longer holds refuses the profile
const keyOfProfile = (
  deps: ProfileDeps,
  profile: Profile,
): Effect.Effect<string, ProfileError | StoreError> =>
  Effect.flatMap(usableKeyOf(deps.secrets, profile.id), (value) =>
    value === undefined ? Effect.fail(invalid(lostKeyReason(profile.id))) : Effect.succeed(value),
  )

// A login profile travels as its ref alone; an api_key profile with its key, in the variable its provider declared
const resolved = (
  deps: ProfileDeps,
  profile: Profile,
): Effect.Effect<ResolvedProfile, ProfileError | StoreError> =>
  profile.kind === 'login'
    ? Effect.succeed({ ref: refOf(profile) })
    : Effect.map(
        Effect.all({ env: keyEnvOf(deps, profile), value: keyOfProfile(deps, profile) }),
        (apiKey) => ({ ref: refOf(profile), apiKey }),
      )

export const resolveProfile = (
  deps: ProfileDeps,
  providerId: string,
  profileId: string | null | undefined,
): Effect.Effect<ResolvedProfile, ProfileError | StoreError> =>
  Effect.gen(function* findsProfile() {
    if (profileId === null || profileId === undefined) {
      const fallback = yield* defaultProfileOf(deps.sql, providerId)
      return fallback === undefined
        ? { ref: namelessRefOf(providerId) }
        : yield* resolved(deps, fallback)
    }
    const profile = yield* requireProfile(deps.sql, profileId)
    if (profile.providerId !== providerId) {
      const reason = `profile "${profileId}" belongs to provider "${profile.providerId}", not "${providerId}"`
      return yield* invalid(reason)
    }
    return yield* resolved(deps, profile)
  })
