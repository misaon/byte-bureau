import { Effect } from 'effect'
import type {
  ConfigError,
  ProfileError,
  SessionError,
  StoreError,
  WorkspaceError,
} from '../errors.js'
import { reasonOf } from '../plugins/reason.js'
import { employeeOf } from './employee-of.js'
import type { SessionDeps } from './session-deps.js'
import { newSession, register, type Checked, type Creation } from './session-new.js'
import { requireProvider } from './session-provider.js'
import {
  baseBranchOf,
  checkRuntime,
  currentProject,
  passEnvOf,
  requireProject,
  runtimeIdOf,
} from './session-project.js'
import type { SessionManagerShape } from './session-shape.js'
import { move, moveToErrored } from './session-status.js'

const provision = (
  deps: SessionDeps,
  { project, session, input }: Creation,
): Effect.Effect<Creation['session'], SessionError | WorkspaceError | StoreError> =>
  Effect.gen(function* provisionsSession() {
    yield* move(deps, session.id, 'provision')
    yield* deps.workspaces.provision({
      sessionId: session.id,
      project,
      title: session.title,
      baseBranch: baseBranchOf(project, input),
      runtimeId: runtimeIdOf(project),
    })
    return yield* move(deps, session.id, 'provisioned')
  })

const failureText = (failure: SessionError | WorkspaceError | StoreError): string =>
  'reason' in failure ? failure.reason : reasonOf(failure.cause)

// A session that cannot be provisioned has crashed: it stays on record as errored, and the caller learns why
const provisionOrCrash = (
  deps: SessionDeps,
  creation: Creation,
): Effect.Effect<Creation['session'], SessionError | WorkspaceError | StoreError> =>
  provision(deps, creation).pipe(
    Effect.tapError((failure) => {
      const message = `provisioning failed: ${failureText(failure)}`
      const failed = moveToErrored(deps, creation.session.id, {
        kind: 'crash',
        message,
        retryable: false,
      })
      return Effect.ignore(failed).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            deps.live.forget(creation.session.id)
          }),
        ),
      )
    }),
  )

type Refusal = SessionError | WorkspaceError | ConfigError | ProfileError | StoreError

// Everything that can be refused is refused first, so a refused session leaves no row and no worktree behind
// The profile is resolved here, so one nobody holds, of another provider or without its key refuses the session
const checked = (deps: SessionDeps, input: Creation['input']): Effect.Effect<Checked, Refusal> =>
  Effect.gen(function* checksCreation() {
    const registered = yield* requireProject(deps, input.projectId)
    const project = yield* currentProject(deps, registered)
    const employee = yield* employeeOf(project, input)
    yield* requireProvider(deps.host, employee.provider)
    const profile = yield* deps.profiles.resolve(employee.provider, input.profileId)
    yield* checkRuntime(deps, employee.permissionMode, runtimeIdOf(project))
    return { project, employee, profile }
  })

export const makeCreate =
  (deps: SessionDeps): SessionManagerShape['create'] =>
  (input) =>
    Effect.gen(function* createsSession() {
      const checks = yield* checked(deps, input)
      const { project, employee } = checks
      const session = newSession(checks, input)
      yield* register(deps, session, input.env ?? {})
      const passEnv = passEnvOf(project, employee.provider)
      deps.live.setEnvironment(session.id, { extra: input.env ?? {}, passEnv })
      return yield* provisionOrCrash(deps, { project, session, input })
    })
