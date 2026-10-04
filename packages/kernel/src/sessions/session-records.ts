import type { ExternalSessionRef } from '@bytebureau/plugin-api'
import { EmployeeSpec, SessionStatus } from '@bytebureau/protocol'
import { Effect, Schema, type Result } from 'effect'
import type { SqlClient } from 'effect/sql'
import { SessionError, StoreError, toStoreError } from '../errors.js'
import { nowIso } from '../ids.js'
import { bytebureauEnv } from '../process/env-allowlist.js'
import { decodeHandle } from '../workspace/workspace-records.js'
import type { KernelInstance } from './live-sessions.js'
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
  env_json: Schema.String,
  owner_pid: Schema.NullOr(Schema.Number),
  owner_instance: Schema.NullOr(Schema.String),
})

const decodeStored = Schema.decodeUnknownEffect(Stored)

const Environment = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
const decodeEnvironment = Schema.decodeUnknownEffect(Environment)

// A row that does not fit the protocol is a failure of the store, not a defect
const unreadable = (cause: unknown): StoreError =>
  new StoreError({ cause: new Error('a session record is unreadable', { cause }) })

const workspaceOf = (json: string): ReturnType<typeof decodeHandle> | Effect.Effect<null> =>
  json === NO_WORKSPACE ? Effect.succeed(null) : decodeHandle(json)

const sessionFrom = (stored: typeof Stored.Type): Effect.Effect<Session, Schema.SchemaError> =>
  Effect.map(workspaceOf(stored.workspace_json), (workspace) => ({
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
  }))

const toSession = (row: unknown): Effect.Effect<Session, StoreError> =>
  decodeStored(row).pipe(Effect.flatMap(sessionFrom), Effect.mapError(unreadable))

// Who works on a session: the process and the kernel that registered, resumed or prompted it last; nobody for a row from before owners were recorded
export interface SessionOwner {
  readonly pid: number | null
  readonly instance: string | null
}

export interface OwnedSession {
  readonly session: Session
  readonly owner: SessionOwner
}

const toOwned = (row: unknown): Effect.Effect<OwnedSession, StoreError> =>
  decodeStored(row).pipe(
    Effect.flatMap((stored) =>
      Effect.map(sessionFrom(stored), (session) => ({
        session,
        owner: { pid: stored.owner_pid, instance: stored.owner_instance },
      })),
    ),
    Effect.mapError(unreadable),
  )

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

// What a session is registered with: the environment given at creation and the kernel that owns it
export interface Registration {
  readonly env: Readonly<Record<string, string>>
  readonly owner: KernelInstance
}

// The workspace stays empty until provisioning has made one; only the BYTEBUREAU_* names of the environment are kept
// The owner goes in with the row, so no recovery of another kernel ever sees the session without one
export const insertSession = (
  sql: SqlClient.SqlClient,
  session: Session,
  { env, owner }: Registration,
): Effect.Effect<void, StoreError> =>
  sql`
    INSERT INTO sessions (id, project_id, title, employee_json, provider_id, profile_id, workspace_json, status, created_at, env_json, owner_pid, owner_instance)
    VALUES (${session.id}, ${session.projectId}, ${session.title}, ${JSON.stringify(session.employee)}, ${session.providerId}, ${session.profileId}, ${NO_WORKSPACE}, ${session.status}, ${session.createdAt}, ${JSON.stringify(bytebureauEnv(env))}, ${owner.pid}, ${owner.id})`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

// A row read on its own: one that does not fit keeps its failure, so it does not hide the others
export interface OwnedRead {
  readonly id: string
  readonly owned: Result.Result<OwnedSession, StoreError>
}

// The sessions in the statuses, with their owners, oldest first
export const listOwned = (
  sql: SqlClient.SqlClient,
  statuses: readonly SessionStatus[],
): Effect.Effect<readonly OwnedRead[], StoreError> =>
  sql<{
    readonly id: string
  }>`SELECT * FROM sessions WHERE ${sql.in('status', statuses)} ORDER BY created_at, id`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) =>
      Effect.all(
        rows.map((row) =>
          Effect.map(Effect.result(toOwned(row)), (owned) => ({ id: row.id, owned })),
        ),
      ),
    ),
  )

export const loadOwned = (
  sql: SqlClient.SqlClient,
  sessionId: string,
): Effect.Effect<OwnedSession | undefined, StoreError> =>
  sql`SELECT * FROM sessions WHERE id = ${sessionId}`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap(([row]) => (row === undefined ? Effect.undefined : toOwned(row))),
  )

// The environment stored at creation; a record that does not fit is a failure of the store
export const loadEnvironment = (
  sql: SqlClient.SqlClient,
  sessionId: string,
): Effect.Effect<Readonly<Record<string, string>>, StoreError> =>
  sql<{ readonly env_json: string }>`SELECT env_json FROM sessions WHERE id = ${sessionId}`.pipe(
    Effect.mapError(toStoreError),
    Effect.map(([row]) => (row === undefined ? '{}' : row.env_json)),
    Effect.flatMap((json) => decodeEnvironment(json).pipe(Effect.mapError(unreadable))),
  )

const ENDED = new Set<string>(['completed', 'stopped', 'errored'])

// The session moves only when it is still in the status the caller saw, so a stale decision claims nothing
// A session starts when it first runs and ends when it completes, stops or fails; resuming clears the end
// The kernel that resumes a session, or sets its agent to work, owns it from then on: named in the same statement, so a refused move names nobody
export interface StatusClaim {
  readonly next: SessionStatus
  readonly owner?: KernelInstance | undefined
}

export const claimStatus = (
  sql: SqlClient.SqlClient,
  session: Session,
  { next, owner }: StatusClaim,
): Effect.Effect<Session | undefined, StoreError> => {
  const now = nowIso()
  const startedAt = next === 'running' ? now : null
  const endedAt = ENDED.has(next) ? now : null
  const ownerPid = owner === undefined ? null : owner.pid
  const ownerInstance = owner === undefined ? null : owner.id
  return sql`
    UPDATE sessions SET status = ${next}, started_at = COALESCE(started_at, ${startedAt}), ended_at = ${endedAt},
      owner_pid = COALESCE(${ownerPid}, owner_pid), owner_instance = COALESCE(${ownerInstance}, owner_instance)
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
