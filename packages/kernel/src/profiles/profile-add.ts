import { Effect } from 'effect'
import { ProfileError, type SessionError, type StoreError } from '../errors.js'
import { nowIso } from '../ids.js'
import { requireProvider } from '../sessions/session-provider.js'
import { ensureProfileDir, profileDirOf } from './profile-dirs.js'
import { isProfileName, profileIdOf } from './profile-ids.js'
import { writeKey } from './profile-keys.js'
import { claimProfile, defaultProfileOf, forgetProfile, markDefault } from './profile-records.js'
import type { AddProfileInput, Profile, ProfileDeps } from './profile-types.js'

const invalid = (reason: string): ProfileError => new ProfileError({ code: 'invalid', reason })

// What the name and the kind of a profile allow: a login has no key, an api_key profile has one and a provider that takes it
const refusalOf = (
  input: AddProfileInput,
  apiKeyEnv: string | undefined,
): ProfileError | undefined => {
  if (!isProfileName(input.name)) {
    return invalid(
      `"${input.name}" is not a profile name: lower-case letters, digits and dashes, 1 to 32 of them`,
    )
  }
  if (input.kind === 'login') {
    return input.apiKey === undefined ? undefined : invalid('a login profile takes no key')
  }
  if (apiKeyEnv === undefined) {
    return invalid(`provider "${input.providerId}" takes no API-key profile`)
  }
  return input.apiKey === undefined || input.apiKey === ''
    ? invalid('an api_key profile needs its key')
    : undefined
}

// What add refuses before anything is written; the id of the profile otherwise
const checkedId = (
  deps: ProfileDeps,
  input: AddProfileInput,
): Effect.Effect<string, ProfileError | SessionError> =>
  Effect.flatMap(requireProvider(deps.host, input.providerId), (provider) => {
    const refusal = refusalOf(input, provider.apiKeyEnv)
    return refusal === undefined
      ? Effect.succeed(profileIdOf(input.providerId, input.name))
      : Effect.fail(refusal)
  })

// What a profile keeps outside its row: the directory of a login, or the key of an api_key profile
const keep = (
  deps: ProfileDeps,
  profile: Profile,
  apiKey: string | undefined,
): Effect.Effect<void, StoreError> =>
  profile.configDir === null
    ? writeKey(deps.secrets, profile.id, apiKey ?? '')
    : ensureProfileDir(profile.configDir)

// The row claims the id first, so a second add of the profile neither overwrites its key nor shares its directory
// A profile whose key or directory cannot be kept is not added: its row goes again
const claim = (
  deps: ProfileDeps,
  profile: Profile,
  apiKey: string | undefined,
): Effect.Effect<void, ProfileError | StoreError> =>
  Effect.flatMap(
    claimProfile(deps.sql, profile),
    (claimed): Effect.Effect<void, ProfileError | StoreError> =>
      claimed
        ? keep(deps, profile, apiKey).pipe(
            Effect.tapError(() => Effect.ignore(forgetProfile(deps.sql, profile.id))),
          )
        : Effect.fail(
            new ProfileError({ code: 'exists', reason: `profile "${profile.id}" exists` }),
          ),
  )

// The first profile of a provider becomes its default, and makeDefault moves the default to the new one
export const addProfile = (
  deps: ProfileDeps,
  input: AddProfileInput,
): Effect.Effect<Profile, ProfileError | SessionError | StoreError> =>
  Effect.gen(function* addsProfile() {
    const id = yield* checkedId(deps, input)
    const first = (yield* defaultProfileOf(deps.sql, input.providerId)) === undefined
    const profile: Profile = {
      id,
      providerId: input.providerId,
      name: input.name,
      kind: input.kind,
      configDir:
        input.kind === 'login' ? profileDirOf(deps.home, input.providerId, input.name) : null,
      isDefault: first || input.makeDefault === true,
      createdAt: nowIso(),
    }
    yield* claim(deps, profile, input.apiKey)
    if (profile.isDefault) {
      yield* markDefault(deps.sql, profile.providerId, id)
    }
    const payload = { profileId: id, providerId: profile.providerId }
    yield* deps.log.publish({ type: 'profile.added', payload })
    return profile
  })
