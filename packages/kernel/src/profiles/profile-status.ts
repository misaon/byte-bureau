import { existsSync } from 'node:fs'
import type { AgentProvider, AuthStatus, ProfileRef } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import type { ProfileError, StoreError } from '../errors.js'
import { nowIso } from '../ids.js'
import { reasonOf } from '../plugins/reason.js'
import { requireProfile } from './profile-records.js'
import type { Profile, ProfileDeps, ProfileStatus } from './profile-types.js'

export const refOf = (profile: Profile): ProfileRef => ({
  id: profile.id,
  providerId: profile.providerId,
  kind: profile.kind,
  ...(profile.configDir === null ? {} : { configDir: profile.configDir }),
})

// The directory of a login profile when it is gone, which holds no login: the answer is known whatever the provider says
const goneDirectoryOf = (profile: Profile): string | undefined =>
  profile.kind === 'login' && profile.configDir !== null && !existsSync(profile.configDir)
    ? profile.configDir
    : undefined

// What the provider says; one that cannot say is unknown, with its reason as the hint
const asked = (provider: AgentProvider, ref: ProfileRef): Effect.Effect<AuthStatus> =>
  Effect.tryPromise({
    try: async () => {
      const status = await provider.authStatus(ref)
      return status
    },
    catch: reasonOf,
  }).pipe(
    Effect.match({
      onFailure: (reason): AuthStatus => ({ state: 'unknown', hint: reason }),
      onSuccess: (status) => status,
    }),
  )

// Where to log in again: the provider's words when it says logged out too, else the directory the kernel knows
const goneHint = (status: AuthStatus, directory: string): string =>
  status.state === 'loggedOut' && status.hint !== undefined
    ? status.hint
    : `the directory ${directory} is gone; add the profile again`

const statusOf = (provider: AgentProvider, profile: Profile): Effect.Effect<ProfileStatus> =>
  Effect.map(asked(provider, refOf(profile)), (status): ProfileStatus => {
    const checkedAt = nowIso()
    const gone = goneDirectoryOf(profile)
    if (gone !== undefined) {
      return { profileId: profile.id, state: 'loggedOut', hint: goneHint(status, gone), checkedAt }
    }
    return {
      profileId: profile.id,
      state: status.state,
      ...(status.hint === undefined ? {} : { hint: status.hint }),
      ...(status.account === undefined ? {} : { account: status.account }),
      checkedAt,
    }
  })

// A provider that is not loaded cannot be asked
const unloaded = (profile: Profile): ProfileStatus => ({
  profileId: profile.id,
  state: 'unknown',
  hint: `provider "${profile.providerId}" is not loaded`,
  checkedAt: nowIso(),
})

export const profileStatus = (
  deps: ProfileDeps,
  id: string,
): Effect.Effect<ProfileStatus, ProfileError | StoreError> =>
  Effect.gen(function* tellsStatus() {
    const profile = yield* requireProfile(deps.sql, id)
    const provider = deps.host.agentProvider(profile.providerId)
    const checked = provider === undefined ? unloaded(profile) : yield* statusOf(provider, profile)
    yield* deps.log.publish({
      type: 'profile.status',
      payload: { profileId: id, state: checked.state },
    })
    return checked
  })
