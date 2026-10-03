import { decodeProjectConfig, type ProjectConfig } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { StoreError, toStoreError, WorkspaceError } from '../errors.js'

export interface Project {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly defaultBranch: string
  readonly config: ProjectConfig
  readonly createdAt: string
  readonly updatedAt: string
}

export interface Row {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly default_branch: string
  readonly config_json: string
  readonly created_at: string
  readonly updated_at: string
}

const unreadable =
  (row: Row): ((cause: unknown) => StoreError) =>
  (cause) =>
    new StoreError({
      cause: new Error(`the configuration snapshot of project ${row.id} is unreadable`, { cause }),
    })

// The snapshot is decoded again; a row that no longer fits the schema is a failure of the store that names the project
const fromRow = (row: Row): Effect.Effect<Project, StoreError> =>
  Effect.try({
    try: () => decodeProjectConfig(JSON.parse(row.config_json)),
    catch: unreadable(row),
  }).pipe(
    Effect.map((config) => ({
      id: row.id,
      name: row.name,
      path: row.path,
      defaultBranch: row.default_branch,
      config,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  )

export const findByPath = (
  sql: SqlClient.SqlClient,
  root: string,
): Effect.Effect<Row | undefined, StoreError> =>
  sql<Row>`SELECT * FROM projects WHERE path = ${root}`.pipe(
    Effect.map(([row]) => row),
    Effect.mapError(toStoreError),
  )

export const insertProject = (
  sql: SqlClient.SqlClient,
  project: Project,
): Effect.Effect<void, StoreError> =>
  sql`
    INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at)
    VALUES (${project.id}, ${project.name}, ${project.path}, ${project.defaultBranch}, ${JSON.stringify(project.config)}, ${project.createdAt}, ${project.updatedAt})`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

export const updateProject = (
  sql: SqlClient.SqlClient,
  project: Project,
): Effect.Effect<void, StoreError> =>
  sql`
    UPDATE projects
    SET name = ${project.name}, default_branch = ${project.defaultBranch}, config_json = ${JSON.stringify(project.config)}, updated_at = ${project.updatedAt}
    WHERE id = ${project.id}`.pipe(Effect.asVoid, Effect.mapError(toStoreError))

// By name whatever its case, then by path, so two projects of one name keep their order
export const listProjects = (
  sql: SqlClient.SqlClient,
): Effect.Effect<readonly Project[], StoreError> =>
  sql<Row>`SELECT * FROM projects ORDER BY name COLLATE NOCASE, path`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => Effect.all(rows.map((row) => fromRow(row)))),
  )

export const getProject = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<Project | undefined, StoreError> =>
  sql<Row>`SELECT * FROM projects WHERE id = ${id}`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap(([row]) => (row === undefined ? Effect.undefined : fromRow(row))),
  )

interface Usage {
  readonly name: string
  readonly sessions: number
}

const usageOf = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<Usage | undefined, StoreError> =>
  sql<Usage>`
    SELECT name, (SELECT COUNT(*) FROM sessions WHERE project_id = projects.id) AS sessions
    FROM projects WHERE id = ${id}`.pipe(
    Effect.map(([usage]) => usage),
    Effect.mapError(toStoreError),
  )

const inUse = ({ name, sessions }: Usage): WorkspaceError =>
  new WorkspaceError({
    code: 'has_sessions',
    reason: `project ${name} still has ${sessions} ${sessions === 1 ? 'session' : 'sessions'}`,
  })

// A project that sessions still belong to stays; the result tells whether a row was deleted
// The count and the delete share one transaction, so a session created in between cannot slip past
export const deleteProject = (
  sql: SqlClient.SqlClient,
  id: string,
): Effect.Effect<boolean, StoreError | WorkspaceError> =>
  sql
    .withTransaction(
      Effect.gen(function* deletesProject() {
        const usage = yield* usageOf(sql, id)
        if (usage !== undefined && usage.sessions > 0) {
          return yield* inUse(usage)
        }
        const deleted = yield* sql`DELETE FROM projects WHERE id = ${id} RETURNING id`.pipe(
          Effect.mapError(toStoreError),
        )
        return deleted.length > 0
      }),
    )
    .pipe(Effect.catchTag('SqlError', (failure) => Effect.fail(toStoreError(failure))))
