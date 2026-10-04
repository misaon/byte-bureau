import { ProfileService } from '../profiles/profile-service.js'
import type { Promised } from './promised.js'
import type { Kernel } from './types.js'

export const profilesApi = (promised: Promised): Kernel['profiles'] => ({
  list: promised(ProfileService, (profiles) => profiles.list()),
  get: promised(ProfileService, (profiles, id) => profiles.get(id)),
  add: promised(ProfileService, (profiles, input) => profiles.add(input)),
  remove: promised(ProfileService, (profiles, id, options) => profiles.remove(id, options)),
  setDefault: promised(ProfileService, (profiles, id) => profiles.setDefault(id)),
  status: promised(ProfileService, (profiles, id) => profiles.status(id)),
})
