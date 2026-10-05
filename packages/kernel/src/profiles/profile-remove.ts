import { Effect } from 'effect'
import type { ProfileError, StoreError } from '../errors.js'
import { kernelLogger } from '../logging/logging.js'
import { removeProfileDir } from './profile-dirs.js'
import { dropKey, secretKeyOf } from './profile-keys.js'
import { deleteProfile } from './profile-records.js'
import type { Profile, ProfileDeps, Removal } from './profile-types.js'

const logger = kernelLogger(['bb', 'profiles'])

// What a removed profile leaves when it cannot be discarded is told, and the removal stands
const leftBehind =
  (message: string, left: Readonly<Record<string, string>>) =>
  (failure: StoreError): Effect.Effect<void> =>
    Effect.sync(() => {
      logger.warn(message, { ...left, reason: failure.message })
    })

// What the profile kept outside its row goes after it: its key, and its directory when it is purged
const discard = (deps: ProfileDeps, profile: Profile, removal: Removal): Effect.Effect<void> =>
  Effect.gen(function* discardsProfile() {
    if (profile.kind === 'api_key') {
      const key = secretKeyOf(profile.id)
      const told = leftBehind('a removed profile left its key in the secret store', {
        profileId: profile.id,
        key,
      })
      yield* dropKey(deps.secrets, profile.id).pipe(Effect.catchTag('StoreError', told))
    }
    if (removal.purge === true && profile.configDir !== null) {
      const directory = profile.configDir
      const told = leftBehind('a removed profile left its directory', {
        profileId: profile.id,
        directory,
      })
      yield* removeProfileDir(directory).pipe(Effect.catchTag('StoreError', told))
    }
  })

// The row goes, and the default with it to the next profile, in one transaction; the removal is told once that holds
// What it kept outside its row is discarded whether or not the telling went through: the profile is gone either way
export const removeProfile = (
  deps: ProfileDeps,
  id: string,
  removal: Removal = {},
): Effect.Effect<void, ProfileError | StoreError> =>
  Effect.gen(function* removesProfile() {
    const removed = yield* deleteProfile(deps.sql, id)
    yield* deps.log
      .publish({ type: 'profile.removed', payload: { profileId: id } })
      .pipe(Effect.ensuring(discard(deps, removed, removal)))
  })
