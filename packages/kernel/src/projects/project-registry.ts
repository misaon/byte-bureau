import path from 'node:path'
import type { ProjectConfig } from '@bytebureau/protocol'
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { Config, type ConfigShape } from '../config/config.js'
import { WorkspaceError, type ConfigError, type StoreError } from '../errors.js'
import { EventLog, type EventLogShape } from '../events/event-log.js'
import { nowIso, uuidv7 } from '../ids.js'
import { defaultBranchOf, findGitRoot, isByteBureauWorktree } from './git-root.js'
import {
  deleteProject,
  findByPath,
  getProject,
  insertProject,
  listProjects,
  updateProject,
  type Project,
  type Row,
} from './project-records.js'

export type { Project } from './project-records.js'

export interface ProjectRegistryShape {
  readonly register: (
    directory: string,
  ) => Effect.Effect<Project, WorkspaceError | ConfigError | StoreError>
  readonly list: () => Effect.Effect<readonly Project[], StoreError>
  readonly get: (id: string) => Effect.Effect<Project | undefined, StoreError>
  // A project that sessions still belong to is refused with WorkspaceError has_sessions, an id nobody holds with not_found
  readonly remove: (id: string) => Effect.Effect<void, StoreError | WorkspaceError>
}

export class ProjectRegistry extends Context.Service<ProjectRegistry, ProjectRegistryShape>()(
  'bb/ProjectRegistry',
) {}

interface Deps {
  readonly sql: SqlClient.SqlClient
  readonly log: EventLogShape
  readonly config: ConfigShape
}

// The repository's resolved configuration with the two values a project takes from it
interface Snapshot {
  readonly name: string
  readonly defaultBranch: string
  readonly config: ProjectConfig
}

// A session worktree is a checkout of a project, never a project of its own
const repositoryRoot = (directory: string): Effect.Effect<string, WorkspaceError> =>
  Effect.gen(function* findRepositoryRoot() {
    const root = findGitRoot(path.resolve(directory))
    if (root === null) {
      const reason = `${directory} is not inside a git repository`
      return yield* new WorkspaceError({ code: 'not_a_repository', reason })
    }
    if (isByteBureauWorktree(root)) {
      const reason = `${root} is a ByteBureau session worktree`
      return yield* new WorkspaceError({ code: 'is_bytebureau_worktree', reason })
    }
    return root
  })

// A configured default branch wins; otherwise the repository decides: origin/HEAD, else main
const snapshotOf = (config: ConfigShape, root: string): Effect.Effect<Snapshot, ConfigError> =>
  Effect.map(config.load({ projectPath: root }), ({ project }) => ({
    name: project.project.name,
    defaultBranch: project.project.defaultBranch ?? defaultBranchOf(root),
    config: project,
  }))

const announce = (
  log: EventLogShape,
  type: 'project.registered' | 'project.updated',
  project: Project,
): Effect.Effect<void, StoreError> =>
  Effect.asVoid(
    log.publish({
      type,
      projectId: project.id,
      payload: {
        id: project.id,
        name: project.name,
        path: project.path,
        defaultBranch: project.defaultBranch,
      },
    }),
  )

const createProject = (
  { sql, log }: Deps,
  root: string,
  snapshot: Snapshot,
): Effect.Effect<Project, StoreError> =>
  Effect.gen(function* createNewProject() {
    const now = nowIso()
    const project: Project = {
      id: uuidv7(),
      path: root,
      createdAt: now,
      updatedAt: now,
      ...snapshot,
    }
    yield* insertProject(sql, project)
    yield* announce(log, 'project.registered', project)
    return project
  })

// The id and the creation time stay; the snapshot of the repository and the update time are renewed
const refreshProject = (
  { sql, log }: Deps,
  existing: Row,
  snapshot: Snapshot,
): Effect.Effect<Project, StoreError> =>
  Effect.gen(function* refreshKnownProject() {
    const project: Project = {
      id: existing.id,
      path: existing.path,
      createdAt: existing.created_at,
      updatedAt: nowIso(),
      ...snapshot,
    }
    yield* updateProject(sql, project)
    yield* announce(log, 'project.updated', project)
    return project
  })

const makeRegister =
  (deps: Deps): ProjectRegistryShape['register'] =>
  (directory) =>
    Effect.gen(function* registerProject() {
      const root = yield* repositoryRoot(directory)
      const snapshot = yield* snapshotOf(deps.config, root)
      const existing = yield* findByPath(deps.sql, root)
      if (existing === undefined) {
        return yield* createProject(deps, root, snapshot)
      }
      return yield* refreshProject(deps, existing, snapshot)
    })

// An id nobody holds fails, as it does through the API, and announces nothing
const makeRemove =
  ({ sql, log }: Deps): ProjectRegistryShape['remove'] =>
  (id) =>
    Effect.gen(function* removeProject() {
      const removed = yield* deleteProject(sql, id)
      yield* removed
        ? Effect.asVoid(log.publish({ type: 'project.removed', projectId: id, payload: { id } }))
        : Effect.fail(new WorkspaceError({ code: 'not_found', reason: `no project ${id}` }))
    })

const make = Effect.gen(function* makeProjectRegistry() {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const config = yield* Config
  const deps: Deps = { sql, log, config }
  return ProjectRegistry.of({
    register: makeRegister(deps),
    list: () => listProjects(sql),
    get: (id) => getProject(sql, id),
    remove: makeRemove(deps),
  })
})

export const ProjectRegistryLive: Layer.Layer<
  ProjectRegistry,
  never,
  SqlClient.SqlClient | EventLog | Config
> = Layer.effect(ProjectRegistry, make)
