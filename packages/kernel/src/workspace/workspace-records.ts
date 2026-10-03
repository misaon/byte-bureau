import { existsSync } from 'node:fs'
import type { WorkspaceHandle } from '@bytebureau/plugin-api'
import { Effect, Schema } from 'effect'
import type { SqlClient, Statement } from 'effect/sql'
import { StoreError, toStoreError } from '../errors.js'

export interface WorkspaceInfo {
  readonly sessionId: string
  readonly projectId: string
  readonly path: string
  readonly branch: string
  readonly baseRef: string
  readonly sessionStatus: string
  readonly exists: boolean
}

// A session with a provisioned workspace, and what the retention policy needs to know about it
export interface Workspace {
  readonly sessionId: string
  readonly projectId: string
  readonly sessionStatus: string
  readonly endedAt: string | null
  readonly retainDays: number
  readonly handle: WorkspaceHandle
  readonly exists: boolean
}

interface Row {
  readonly id: string
  readonly project_id: string
  readonly status: string
  readonly ended_at: string | null
  readonly workspace_json: string
  readonly retain_days: number
}

// The handle a runtime returned, as the session row keeps it
const StoredHandle = Schema.Struct({
  id: Schema.String,
  runtimeId: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
})

// The handle of a session as its row keeps it, read back from the JSON text of the column
export const decodeHandle = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredHandle))

const unreadable =
  (sessionId: string): ((cause: unknown) => StoreError) =>
  (cause) =>
    new StoreError({
      cause: new Error(`the workspace record of session ${sessionId} is unreadable`, { cause }),
    })

// A record that does not fit the handle is a failure of the store, not a defect
const toWorkspace = (row: Row): Effect.Effect<Workspace, StoreError> =>
  decodeHandle(row.workspace_json).pipe(
    Effect.map((handle) => ({
      sessionId: row.id,
      projectId: row.project_id,
      sessionStatus: row.status,
      endedAt: row.ended_at,
      retainDays: row.retain_days,
      handle,
      exists: existsSync(handle.path),
    })),
    Effect.mapError(unreadable(row.id)),
  )

// A session without a workspace carries '{}'; a named project narrows the query itself
const conditions = (
  sql: SqlClient.SqlClient,
  projectId: string | undefined,
): readonly Statement.Fragment[] => [
  sql`sessions.workspace_json != '{}'`,
  ...(projectId === undefined ? [] : [sql`sessions.project_id = ${projectId}`]),
]

// The merged project snapshot normally holds retainDays; without it a worktree stays seven days
const selectRows = (
  sql: SqlClient.SqlClient,
  projectId: string | undefined,
): Effect.Effect<readonly Row[], StoreError> =>
  sql<Row>`
    SELECT sessions.id, sessions.project_id, sessions.status, sessions.ended_at, sessions.workspace_json,
      COALESCE(json_extract(projects.config_json, '$.workspace.retainDays'), 7) AS retain_days
    FROM sessions JOIN projects ON projects.id = sessions.project_id
    WHERE ${sql.and(conditions(sql, projectId))}
    ORDER BY sessions.created_at, sessions.id`.pipe(Effect.mapError(toStoreError))

export const loadWorkspaces = (
  sql: SqlClient.SqlClient,
  projectId: string | undefined,
): Effect.Effect<readonly Workspace[], StoreError> =>
  selectRows(sql, projectId).pipe(
    Effect.flatMap((rows) => Effect.all(rows.map((row) => toWorkspace(row)))),
  )

export const saveHandle = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  handle: WorkspaceHandle,
): Effect.Effect<void, StoreError> =>
  sql`UPDATE sessions SET workspace_json = ${JSON.stringify(handle)} WHERE id = ${sessionId}`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

const infoOf = ({ handle, ...workspace }: Workspace): WorkspaceInfo => ({
  sessionId: workspace.sessionId,
  projectId: workspace.projectId,
  path: handle.path,
  branch: handle.branch,
  baseRef: handle.baseRef,
  sessionStatus: workspace.sessionStatus,
  exists: workspace.exists,
})

export const listWorkspaces = (
  sql: SqlClient.SqlClient,
  projectId: string | undefined,
): Effect.Effect<readonly WorkspaceInfo[], StoreError> =>
  loadWorkspaces(sql, projectId).pipe(
    Effect.map((workspaces) => workspaces.map((workspace) => infoOf(workspace))),
  )
