import {
  AnsweredVia,
  Ask,
  AskAnswer,
  AskStatus,
  Timestamp,
  type AskRecord,
} from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import type { SqlClient, Statement } from 'effect/sql'
import { StoreError, toStoreError } from '../errors.js'

// The columns that make an ask whole: the payload it was opened with and the state that came after
const Stored = Schema.Struct({
  payload_json: Schema.fromJsonString(Ask),
  status: AskStatus,
  answer_json: Schema.NullOr(Schema.fromJsonString(AskAnswer)),
  answered_at: Schema.NullOr(Timestamp),
  answered_via: Schema.NullOr(AnsweredVia),
})

const decodeStored = Schema.decodeUnknownEffect(Stored)

// A row that does not fit the protocol is a failure of the store, not a defect
const toRecord = (row: unknown): Effect.Effect<AskRecord, StoreError> =>
  decodeStored(row).pipe(
    Effect.map((stored) => ({
      ...stored.payload_json,
      status: stored.status,
      answer: stored.answer_json,
      answeredAt: stored.answered_at,
      answeredVia: stored.answered_via,
    })),
    Effect.mapError(
      (cause) => new StoreError({ cause: new Error('an ask record is unreadable', { cause }) }),
    ),
  )

// The record of the first row; a query that finds no row, or an update that claims none, has no record
const firstRecord = (
  rows: readonly unknown[],
): Effect.Effect<AskRecord | undefined, StoreError> => {
  const [row] = rows
  return row === undefined ? Effect.undefined : toRecord(row)
}

export const insertAsk = (sql: SqlClient.SqlClient, ask: Ask): Effect.Effect<void, StoreError> =>
  sql`
    INSERT INTO asks (id, session_id, turn_id, kind, payload_json, status, recommendation_source, created_at, deadline_at)
    VALUES (${ask.id}, ${ask.sessionId}, ${ask.turnId}, ${ask.kind}, ${JSON.stringify(ask)}, ${ask.status}, ${ask.recommendationSource}, ${ask.createdAt}, ${ask.deadlineAt})`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

export const loadAsk = (
  sql: SqlClient.SqlClient,
  askId: string,
): Effect.Effect<AskRecord | undefined, StoreError> =>
  sql`SELECT * FROM asks WHERE id = ${askId}`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => firstRecord(rows)),
  )

// Pending asks, oldest first; the id breaks a tie because uuidv7 ids grow with time
const pendingConditions = (
  sql: SqlClient.SqlClient,
  sessionId?: string,
): readonly Statement.Fragment[] => [
  sql`status = 'pending'`,
  ...(sessionId === undefined ? [] : [sql`session_id = ${sessionId}`]),
]

export const listPending = (
  sql: SqlClient.SqlClient,
  sessionId?: string,
): Effect.Effect<readonly AskRecord[], StoreError> =>
  sql`SELECT * FROM asks WHERE ${sql.and(pendingConditions(sql, sessionId))} ORDER BY created_at, id`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => Effect.all(rows.map((row) => toRecord(row)))),
  )

export interface Answered {
  readonly answer: AskAnswer
  readonly via: AnsweredVia
  readonly answeredAt: string
}

// Only a pending ask can be answered, whoever asks first wins
export const claimAnswer = (
  sql: SqlClient.SqlClient,
  askId: string,
  { answer, via, answeredAt }: Answered,
): Effect.Effect<AskRecord | undefined, StoreError> =>
  sql`
    UPDATE asks SET status = 'answered', answer_json = ${JSON.stringify(answer)}, answered_at = ${answeredAt}, answered_via = ${via}
    WHERE id = ${askId} AND status = 'pending' RETURNING *`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => firstRecord(rows)),
  )

// Only a pending ask can be cancelled
export const claimCancel = (
  sql: SqlClient.SqlClient,
  askId: string,
): Effect.Effect<AskRecord | undefined, StoreError> =>
  sql`UPDATE asks SET status = 'cancelled' WHERE id = ${askId} AND status = 'pending' RETURNING *`.pipe(
    Effect.mapError(toStoreError),
    Effect.flatMap((rows) => firstRecord(rows)),
  )
