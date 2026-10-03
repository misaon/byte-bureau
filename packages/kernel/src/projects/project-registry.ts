import path from 'node:path'
import { decodeProjectConfig, type ProjectConfig } from '@bytebureau/protocol'
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { Config, type ConfigShape } from '../config/config.js'
import { toStoreError, WorkspaceError, type ConfigError, type StoreError } from '../errors.js'
import { EventLog, type EventLogShape } from '../events/event-log.js'
import { nowIso, uuidv7 } from '../ids.js'
import { defaultBranchOf, findGitRoot, isByteBureauWorktree } from './git-root.js'

export interface Project {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly defaultBranch: string
  readonly config: ProjectConfig
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ProjectRegistryShape {
  readonly register: (
    directory: string,
  ) => Effect.Effect<Project, WorkspaceError | ConfigError | StoreError>
  readonly list: () => Effect.Effect<readonly Project[], StoreError>
  readonly get: (id: string) => Effect.Effect<Project | undefined, StoreError>
  readonly remove: (id: string) => Effect.Effect<void, StoreError>
}

export class ProjectRegistry extends Context.Service<ProjectRegistry, ProjectRegistryShape>()(
  'bb/ProjectRegistry',
) {}

interface Row {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly default_branch: string
  readonly config_json: string
  readonly created_at: string
  readonly updated_at: string
}

// The snapshot is decoded again, so a row that no longer fits the schema fails loudly
const fromRow = (row: Row): Project => ({
  id: row.id,
  name: row.name,
  path: row.path,
  defaultBranch: row.default_branch,
  config: decodeProjectConfig(JSON.parse(row.config_json)),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

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

const findByPath = (
  sql: SqlClient.SqlClient,
  root: string,
): Effect.Effect<Row | undefined, StoreError> =>
  sql<Row>`SELECT * FROM projects WHERE path = ${root}`.pipe(
    Effect.map(([row]) => row),
    Effect.mapError(toStoreError),
  )

const insertProject = (
  sql: SqlClient.SqlClient,
  project: Project,
): Effect.Effect<void, StoreError> =>
  sql`
    INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at)
    VALUES (${project.id}, ${project.name}, ${project.path}, ${project.defaultBranch}, ${JSON.stringify(project.config)}, ${project.createdAt}, ${project.updatedAt})`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

const updateProject = (
  sql: SqlClient.SqlClient,
  project: Project,
): Effect.Effect<void, StoreError> =>
  sql`
    UPDATE projects
    SET name = ${project.name}, default_branch = ${project.defaultBranch}, config_json = ${JSON.stringify(project.config)}, updated_at = ${project.updatedAt}
    WHERE id = ${project.id}`.pipe(Effect.asVoid, Effect.mapError(toStoreError))

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

const makeList =
  (sql: SqlClient.SqlClient): ProjectRegistryShape['list'] =>
  () =>
    sql<Row>`SELECT * FROM projects ORDER BY name`.pipe(
      Effect.map((rows) => rows.map((row) => fromRow(row))),
      Effect.mapError(toStoreError),
    )

const makeGet =
  (sql: SqlClient.SqlClient): ProjectRegistryShape['get'] =>
  (id) =>
    sql<Row>`SELECT * FROM projects WHERE id = ${id}`.pipe(
      Effect.map(([row]) => (row === undefined ? undefined : fromRow(row))),
      Effect.mapError(toStoreError),
    )

// Removing an id nobody holds is not an error: the announcement still goes out
const makeRemove =
  ({ sql, log }: Deps): ProjectRegistryShape['remove'] =>
  (id) =>
    Effect.gen(function* removeProject() {
      yield* sql`DELETE FROM projects WHERE id = ${id}`.pipe(Effect.mapError(toStoreError))
      yield* log.publish({ type: 'project.removed', projectId: id, payload: { id } })
    })

const make = Effect.gen(function* makeProjectRegistry() {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const config = yield* Config
  const deps: Deps = { sql, log, config }
  return ProjectRegistry.of({
    register: makeRegister(deps),
    list: makeList(sql),
    get: makeGet(sql),
    remove: makeRemove(deps),
  })
})

export const ProjectRegistryLive: Layer.Layer<
  ProjectRegistry,
  never,
  SqlClient.SqlClient | EventLog | Config
> = Layer.effect(ProjectRegistry, make)
