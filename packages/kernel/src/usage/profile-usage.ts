import type { UsageSnapshotDto } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { ProfileError, StoreError } from '../errors.js'
import { NAMELESS_PROFILE_ID } from '../profiles/profile-ids.js'
import { missingProfile } from '../profiles/profile-records.js'
import { ProfileService } from '../profiles/profile-service.js'
import { UsageService } from './usage-service.js'

// The newest rate limit seen under a profile, empty before any, as the API and the facade tell it
// The nameless login files its snapshots under "default", which no stored profile can be called; any other id nobody holds is not found
export const profileUsage = (
  id: string,
): Effect.Effect<UsageSnapshotDto, ProfileError | StoreError, ProfileService | UsageService> =>
  Effect.gen(function* readsProfileUsage() {
    if (id !== NAMELESS_PROFILE_ID) {
      const profile = yield* ProfileService.use((profiles) => profiles.get(id))
      if (profile === undefined) {
        return yield* missingProfile(id)
      }
    }
    const snapshot = yield* UsageService.use((usage) => usage.snapshot(id))
    return snapshot ?? { profileId: id, rateLimit: {}, observedAt: null }
  })
