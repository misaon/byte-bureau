import { Effect } from 'effect'
import { SessionError, WorkspaceError, type StoreError } from '../errors.js'
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

export const runtimeIdOf = ({ config }: Project): string =>
  config.workspace === undefined || config.workspace.runtime === undefined
    ? 'local'
    : config.workspace.runtime

// The branch the worktree starts from: the caller's, else the project's configured one, else the default branch of the repository
export const baseBranchOf = (project: Project, input: CreateSessionInput): string => {
  const { defaults } = project.config
  const configured = defaults === undefined ? undefined : defaults.branch
  return input.branch ?? configured ?? project.defaultBranch
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
