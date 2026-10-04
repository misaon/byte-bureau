import { Effect } from 'effect'
import type { ConfigError, SessionError, StoreError } from '../errors.js'
import type { SessionEnvironment } from './live-sessions.js'
import type { SessionDeps } from './session-deps.js'
import { currentProject, passEnvOf, requireProject } from './session-project.js'
import { loadEnvironment } from './session-records.js'
import type { Session } from './types.js'

// A session resumed by a later process gives its agent what its first start had: the stored BYTEBUREAU_* variables and the passEnv names of its provider as the project configures them now
export const storedEnvironment = (
  deps: SessionDeps,
  session: Session,
): Effect.Effect<SessionEnvironment, SessionError | StoreError | ConfigError> =>
  Effect.gen(function* readsEnvironment() {
    const extra = yield* loadEnvironment(deps.sql, session.id)
    const registered = yield* requireProject(deps, session.projectId)
    const project = yield* currentProject(deps, registered)
    return { extra, passEnv: passEnvOf(project, session.providerId) }
  })
