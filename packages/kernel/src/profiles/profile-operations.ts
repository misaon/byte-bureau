import { addProfile } from './profile-add.js'
import { listProfiles, loadProfile, makeDefault } from './profile-records.js'
import { removeProfile } from './profile-remove.js'
import { resolveProfile } from './profile-resolve.js'
import { profileStatus } from './profile-status.js'
import type { ProfileDeps, ProfileServiceShape } from './profile-types.js'

// The operations of the service over what it works with
export const profileOperations = (deps: ProfileDeps): ProfileServiceShape => ({
  list: () => listProfiles(deps.sql),
  get: (id) => loadProfile(deps.sql, id),
  add: (input) => addProfile(deps, input),
  remove: (id, removal) => removeProfile(deps, id, removal),
  setDefault: (id) => makeDefault(deps.sql, id),
  status: (id) => profileStatus(deps, id),
  resolve: (providerId, profileId) => resolveProfile(deps, providerId, profileId),
})
