import type { ProfileRef, ProjectTrust } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import { readLayer, type LoadedFile } from '../config/files.js'
import type { ConfigError, ProfileError, SessionError, StoreError } from '../errors.js'
import { namelessRefOf } from '../profiles/profile-ids.js'
import type { SessionDeps } from './session-deps.js'
import { logger } from './session-logger.js'
import { providerOptionsOf, requireProject } from './session-project.js'
import { gateProviderConfig, type Gated } from './session-trust.js'
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

// What a configuration error of a section is told against when no one file of the project sets it
export const PROJECT_CONFIGURATION = "the project's configuration"

// What the provider is started with from the project's configuration
export interface ProviderSetup {
  readonly providerConfig: Readonly<Record<string, unknown>>
  readonly trust: ProjectTrust
  // The file a section the provider cannot use came from, when one file alone sets it
  readonly configFile: string
}

const setsSection = (loaded: LoadedFile | null, providerId: string): loaded is LoadedFile => {
  const providers: unknown = loaded === null ? undefined : loaded.config['providers']
  return typeof providers === 'object' && providers !== null && Object.hasOwn(providers, providerId)
}

// The project file the providers.<id> section comes from: bytebureau.json or bytebureau.local.json, or the configuration as a whole
const sectionFileOf = (
  projectPath: string,
  providerId: string,
): Effect.Effect<string, ConfigError> =>
  Effect.map(
    Effect.all([readLayer(projectPath, 'bytebureau'), readLayer(projectPath, 'bytebureau.local')]),
    (loaded) => {
      const [only, other] = loaded.filter((file) => setsSection(file, providerId))
      return only !== undefined && other === undefined ? only.file : PROJECT_CONFIGURATION
    },
  )

// What the project named and the user does not trust is not used, and the person is told: in the log and as a warning of the session
const toldWithheld = (
  deps: SessionDeps,
  session: Session,
  gated: Gated,
): Effect.Effect<void, StoreError> =>
  Effect.forEach(
    gated.warnings,
    (message) => {
      logger.warn(message, { sessionId: session.id })
      return deps.log.publish({
        type: 'session.warning',
        sessionId: session.id,
        projectId: session.projectId,
        payload: { kind: 'trust', message },
      })
    },
    { discard: true },
  )

// The providers.<id> section of the project as it stands now, as the passEnv names of a resumed session are read, through the trust of the user
export const providerSetupOf = (
  deps: SessionDeps,
  session: Session,
): Effect.Effect<ProviderSetup, SessionError | ConfigError | StoreError> =>
  Effect.gen(function* readsProviderSetup() {
    const registered = yield* requireProject(deps, session.projectId)
    const resolved = yield* deps.config.load({ projectPath: registered.path, env: deps.env })
    const gated = gateProviderConfig({
      section: providerOptionsOf({ ...registered, config: resolved.project }, session.providerId),
      providerId: session.providerId,
      projectPath: registered.path,
      user: resolved.user,
      userFile: resolved.files.user ?? deps.config.userFile,
      searchPath: process.env['PATH'] ?? '',
    })
    yield* toldWithheld(deps, session, gated)
    const configFile = yield* sectionFileOf(registered.path, session.providerId)
    return { providerConfig: gated.providerConfig, trust: gated.trust, configFile }
  })
