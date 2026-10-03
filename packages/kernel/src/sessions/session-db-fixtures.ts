import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { toStoreError, type StoreError } from '../errors.js'

export interface TurnRow {
  readonly idx: number
  readonly prompt_json: string
  readonly status: string
  readonly stop_reason: string | null
  readonly usage_json: string | null
  readonly ended_at: string | null
}

export interface ToolRow {
  readonly tool_name: string
  readonly kind: string
  readonly status: string
  readonly output_summary: string | null
  readonly input_bytes: number
  readonly output_bytes: number
  readonly turn_id: string | null
}

export interface MessageRow {
  readonly role: string
  readonly content_json: string
  readonly turn_id: string | null
}

// The turns of a session as the table holds them
export const turnsOf = (
  sessionId: string,
): Effect.Effect<readonly TurnRow[], StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* readsTurns() {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<TurnRow>`SELECT idx, prompt_json, status, stop_reason, usage_json, ended_at FROM turns WHERE session_id = ${sessionId} ORDER BY idx`
  }).pipe(Effect.mapError(toStoreError))

// What became of each turn of a session: its status and why it stopped
export const turnStatesOf = (
  sessionId: string,
): Effect.Effect<readonly (readonly [string, string | null])[], StoreError, SqlClient.SqlClient> =>
  Effect.map(turnsOf(sessionId), (turns) => turns.map((turn) => [turn.status, turn.stop_reason]))

export const toolCallsOf = (
  sessionId: string,
): Effect.Effect<readonly ToolRow[], StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* readsToolCalls() {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<ToolRow>`SELECT tool_name, kind, status, output_summary, input_bytes, output_bytes, turn_id FROM tool_calls WHERE session_id = ${sessionId} ORDER BY started_at, id`
  }).pipe(Effect.mapError(toStoreError))

export const messagesOf = (
  sessionId: string,
): Effect.Effect<readonly MessageRow[], StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* readsMessages() {
    const sql = yield* SqlClient.SqlClient
    return yield* sql<MessageRow>`SELECT role, content_json, turn_id FROM messages WHERE session_id = ${sessionId} ORDER BY created_at, id`
  }).pipe(Effect.mapError(toStoreError))

// A profile row, so that a session can name it
export const seedProfile = (id: string): Effect.Effect<void, StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* seedsProfile() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO profiles (id, provider_id, name, kind, created_at) VALUES (${id}, 'scripted', ${id}, 'login', 't')`
  }).pipe(Effect.mapError(toStoreError))
