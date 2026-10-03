import { Effect } from 'effect'
import { SessionError, WorkspaceError, type ConfigError, type StoreError } from '../errors.js'
import type { Project } from '../projects/project-registry.js'
import type { SessionDeps } from './session-deps.js'
import type { CreateSessionInput } from './types.js'

export const requireProject = (
  deps: SessionDeps,
  projectId: string,
): Effect.Effect<Project, SessionError | StoreError> =>
  Effect.flatMap(deps.projects.get(projectId), (project) =>
    project === undefined
      ? Effect.fail(
          new SessionError({ code: 'not_found', reason: `project ${projectId} is not registered` }),
        )
      : Effect.succeed(project),
  )

// The project with its configuration as it stands now, read with the kernel's environment: BYTEBUREAU_EMPLOYEE, BYTEBUREAU_BRANCH and BYTEBUREAU_WORKSPACE_RUNTIME reach the session
// The snapshot the registry stored stays the record of the registration
export const currentProject = (
  deps: SessionDeps,
  project: Project,
): Effect.Effect<Project, ConfigError> =>
  Effect.map(deps.config.load({ projectPath: project.path, env: deps.env }), (resolved) => ({
    ...project,
    config: resolved.project,
  }))

// The names of further variables the agents of the provider are given, from providers.<id>.passEnv
export const passEnvOf = ({ config }: Project, providerId: string): readonly string[] => {
  const { providers } = config
  const section =
    providers !== undefined && Object.hasOwn(providers, providerId)
      ? providers[providerId]
      : undefined
  return section === undefined ? [] : (section.passEnv ?? [])
}

export const runtimeIdOf = ({ config }: Project): string =>
  config.workspace === undefined || config.workspace.runtime === undefined
    ? 'local'
    : config.workspace.runtime

// The branch the worktree starts from: the caller's, else the configured base, else the configured default branch, else the one detected at registration
export const baseBranchOf = (project: Project, input: CreateSessionInput): string => {
  const { defaults } = project.config
  const configured = defaults === undefined ? undefined : defaults.branch
  return input.branch ?? configured ?? project.config.project.defaultBranch ?? project.defaultBranch
}

// Nothing is created for a runtime that is not there, and yolo needs a runtime that isolates what the agent does
export const checkRuntime = (
  deps: SessionDeps,
  permissionMode: string,
  runtimeId: string,
): Effect.Effect<void, SessionError | WorkspaceError> => {
  const runtime = deps.host.workspaceRuntimes().find((candidate) => candidate.id === runtimeId)
  if (runtime === undefined) {
    const reason = `workspace runtime "${runtimeId}" is not available`
    return Effect.fail(new WorkspaceError({ code: 'runtime_missing', reason }))
  }
  if (permissionMode === 'yolo' && runtime.isolation === 'none') {
    const reason = `permission mode "yolo" is refused on the "${runtimeId}" runtime (isolation: none); container runtimes enable it later`
    return Effect.fail(new SessionError({ code: 'yolo_refused', reason }))
  }
  return Effect.void
}
