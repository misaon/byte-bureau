import type { ExternalSessionRef } from '@bytebureau/plugin-api'
import { EmployeeSpec, SessionStatus } from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import type { SqlClient } from 'effect/sql'
import { SessionError, StoreError, toStoreError } from '../errors.js'
import { nowIso } from '../ids.js'
import { decodeHandle } from '../workspace/workspace-records.js'
import type { Session } from './types.js'

// A session that has no workspace yet carries this record
const NO_WORKSPACE = '{}'

const ExternalRef = Schema.Struct({ providerId: Schema.String, ref: Schema.String })

// The columns of a session row; the JSON ones are read back with the schemas that wrote them
const Stored = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  title: Schema.String,
  employee_json: Schema.fromJsonString(EmployeeSpec),
  provider_id: Schema.String,
  profile_id: Schema.NullOr(Schema.String),
  workspace_json: Schema.String,
  external_ref: Schema.NullOr(Schema.fromJsonString(ExternalRef)),
  status: SessionStatus,
  created_at: Schema.String,
  started_at: Schema.NullOr(Schema.String),
  ended_at: Schema.NullOr(Schema.String),
})

const decodeStored = Schema.decodeUnknownEffect(Stored)

// A row that does not fit the protocol is a failure of the store, not a defect
const unreadable = (cause: unknown): StoreError =>
  new StoreError({ cause: new Error('a session record is unreadable', { cause }) })

const workspaceOf = (json: string): ReturnType<typeof decodeHandle> | Effect.Effect<null> =>
  json === NO_WORKSPACE ? Effect.succeed(null) : decodeHandle(json)

const toSession = (row: unknown): Effect.Effect<Session, StoreError> =>
  Effect.gen(function* decodesSession() {
    const stored = yield* decodeStored(row)
    const workspace = yield* workspaceOf(stored.workspace_json)
    return {
      id: stored.id,
      projectId: stored.project_id,
      title: stored.title,
      employee: stored.employee_json,
      providerId: stored.provider_id,
      profileId: stored.profile_id,
      workspace,
      externalRef: stored.external_ref,
      status: stored.status,
      createdAt: stored.created_at,
      startedAt: stored.started_at,
      endedAt: stored.ended_at,
    }
  }).pipe(Effect.mapError(unreadable))

// The session of the first row; a query that finds no row, or an update that claims none, has none
const firstSession = (rows: readonly unknown[]): Effect.Effect<Session | undefined, StoreError> => {
  const [row] = rows
  return row === undefined ? Effect.undefined : toSession(row)
}

export const loadSession = (
  sql: SqlClient.SqlClient,
  sessionId: string,
): Effect.Effect<Session | undefined, StoreError> =>
  sql`SELECT * FROM sessions WHERE id = ${sessionId}`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => firstSession(rows)),
  )

export const requireSession = (
  sql: SqlClient.SqlClient,
  sessionId: string,
): Effect.Effect<Session, SessionError | StoreError> =>
  loadSession(sql, sessionId).pipe(
    Effect.flatMap((session) =>
      session === undefined
        ? Effect.fail(
            new SessionError({ code: 'not_found', reason: `session ${sessionId} does not exist` }),
          )
        : Effect.succeed(session),
    ),
  )

// Newest first; the id breaks a tie because uuidv7 ids grow with time
export const listSessions = (
  sql: SqlClient.SqlClient,
): Effect.Effect<readonly Session[], StoreError> =>
  sql`SELECT * FROM sessions ORDER BY created_at DESC, id DESC`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => Effect.all(rows.map((row) => toSession(row)))),
  )

// The workspace stays empty until provisioning has made one
export const insertSession = (
  sql: SqlClient.SqlClient,
  session: Session,
): Effect.Effect<void, StoreError> =>
  sql`
    INSERT INTO sessions (id, project_id, title, employee_json, provider_id, profile_id, workspace_json, status, created_at)
    VALUES (${session.id}, ${session.projectId}, ${session.title}, ${JSON.stringify(session.employee)}, ${session.providerId}, ${session.profileId}, ${NO_WORKSPACE}, ${session.status}, ${session.createdAt})`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

const ENDED = new Set<string>(['completed', 'stopped', 'errored'])

// The session moves only when it is still in the status the caller saw, so a stale decision claims nothing
// A session starts when it first runs and ends when it completes, stops or fails; resuming clears the end
export const claimStatus = (
  sql: SqlClient.SqlClient,
  session: Session,
  next: SessionStatus,
): Effect.Effect<Session | undefined, StoreError> => {
  const now = nowIso()
  const startedAt = next === 'running' ? now : null
  const endedAt = ENDED.has(next) ? now : null
  return sql`
    UPDATE sessions SET status = ${next}, started_at = COALESCE(started_at, ${startedAt}), ended_at = ${endedAt}
    WHERE id = ${session.id} AND status = ${session.status} RETURNING *`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => firstSession(rows)),
  )
}

export const saveExternalRef = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  ref: ExternalSessionRef,
): Effect.Effect<void, StoreError> =>
  sql`UPDATE sessions SET external_ref = ${JSON.stringify(ref)} WHERE id = ${sessionId}`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )
