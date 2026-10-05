import path from 'node:path'
import type { ProfileRef } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import type { ConfigError, ProfileError, SessionError, StoreError } from '../errors.js'
import { namelessRefOf } from '../profiles/profile-ids.js'
import type { SessionDeps } from './session-deps.js'
import { providerOptionsOf, requireProject } from './session-project.js'
import type { Session } from './types.js'

// What the profile adds to the start: the ref the provider sees, and the key in the variable the provider named
interface ProfilePart {
  readonly profile: ProfileRef
  readonly env: Readonly<Record<string, string>>
}

// The profile of a session is the one of its creation: a session created without one runs under the nameless login for its whole life, whatever default its provider has since
// A named one is resolved again at each start, so a key that has left the secret store since is noticed
export const profilePartOf = (
  deps: SessionDeps,
  session: Session,
): Effect.Effect<ProfilePart, ProfileError | StoreError> =>
  session.profileId === null
    ? Effect.succeed({ profile: namelessRefOf(session.providerId), env: {} })
    : Effect.map(
        deps.profiles.resolve(session.providerId, session.profileId),
        ({ ref, apiKey }) => ({
          profile: ref,
          env: apiKey === undefined ? {} : { [apiKey.env]: apiKey.value },
        }),
      )

// What the provider is started with from the project's configuration
export interface ProviderSetup {
  readonly providerConfig: Readonly<Record<string, unknown>>
  // The project file a section the provider cannot use is told against: the one that exists, else where it would go
  readonly configFile: string
}

// The providers.<id> section of the project as it stands now, as the passEnv names of a resumed session are read
export const providerSetupOf = (
  deps: SessionDeps,
  session: Session,
): Effect.Effect<ProviderSetup, SessionError | ConfigError | StoreError> =>
  Effect.gen(function* readsProviderSetup() {
    const registered = yield* requireProject(deps, session.projectId)
    const resolved = yield* deps.config.load({ projectPath: registered.path, env: deps.env })
    const project = { ...registered, config: resolved.project }
    return {
      providerConfig: providerOptionsOf(project, session.providerId),
      configFile: resolved.files.project ?? path.join(registered.path, 'bytebureau.json'),
    }
  })
