import type { ProfileRef } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import type { ConfigError, ProfileError, SessionError, StoreError } from '../errors.js'
import type { SessionDeps } from './session-deps.js'
import { currentProject, providerOptionsOf, requireProject } from './session-project.js'
import type { Session } from './types.js'

// What the profile adds to the start: the ref the provider sees, and the key in the variable the provider named
interface ProfilePart {
  readonly profile: ProfileRef
  readonly env: Readonly<Record<string, string>>
}

// Resolved again at each start, so a key that has left the secret store since the creation is noticed
export const profilePartOf = (
  deps: SessionDeps,
  session: Session,
): Effect.Effect<ProfilePart, ProfileError | StoreError> =>
  Effect.map(deps.profiles.resolve(session.providerId, session.profileId), ({ ref, apiKey }) => ({
    profile: ref,
    env: apiKey === undefined ? {} : { [apiKey.env]: apiKey.value },
  }))

// The providers.<id> section of the project as it stands now, as the passEnv names of a resumed session are read
export const providerConfigOf = (
  deps: SessionDeps,
  session: Session,
): Effect.Effect<Readonly<Record<string, unknown>>, SessionError | ConfigError | StoreError> =>
  Effect.gen(function* readsProviderConfig() {
    const registered = yield* requireProject(deps, session.projectId)
    const project = yield* currentProject(deps, registered)
    return providerOptionsOf(project, session.providerId)
  })
