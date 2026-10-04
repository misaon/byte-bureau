import { Effect } from 'effect'
import type { ProfileError, StoreError } from '../errors.js'
import { removeProfileDir } from './profile-dirs.js'
import { dropKey } from './profile-keys.js'
import { deleteProfile, markDefault, oldestProfileOf } from './profile-records.js'
import type { Profile, ProfileDeps, Removal } from './profile-types.js'

// What the profile kept outside its row goes with it: its key, and its directory when it is purged
const discard = (
  deps: ProfileDeps,
  profile: Profile,
  removal: Removal,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* discardsProfile() {
    if (profile.kind === 'api_key') {
      yield* dropKey(deps.secrets, profile.id)
    }
    if (removal.purge === true && profile.configDir !== null) {
      yield* removeProfileDir(profile.configDir)
    }
  })

// The default passes to the oldest profile left of the provider, when the removed one held it
const passDefault = (deps: ProfileDeps, removed: Profile): Effect.Effect<void, StoreError> =>
  removed.isDefault
    ? Effect.flatMap(oldestProfileOf(deps.sql, removed.providerId), (next) =>
        next === undefined ? Effect.void : markDefault(deps.sql, removed.providerId, next.id),
      )
    : Effect.void

export const removeProfile = (
  deps: ProfileDeps,
  id: string,
  removal: Removal = {},
): Effect.Effect<void, ProfileError | StoreError> =>
  Effect.gen(function* removesProfile() {
    const removed = yield* deleteProfile(deps.sql, id)
    yield* discard(deps, removed, removal)
    yield* passDefault(deps, removed)
    yield* deps.log.publish({ type: 'profile.removed', payload: { profileId: id } })
  })
