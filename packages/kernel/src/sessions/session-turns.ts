import type { KernelEvent, PromptInput, TurnStatus, Usage } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { toStoreError, type StoreError } from '../errors.js'
import type { EventLogShape } from '../events/event-log.js'
import { nowIso, uuidv7 } from '../ids.js'
import type { TurnRef } from './translate.js'
import type { Session, Turn } from './types.js'

interface TurnDeps {
  readonly sql: SqlClient.SqlClient
  readonly log: EventLogShape
}

// How a turn ended; a turn that is still running has no outcome
// A completed turn reports its usage, one that was interrupted or failed may not have
export type Outcome =
  | { readonly status: 'completed'; readonly stopReason: string; readonly usage: Usage }
  | {
      readonly status: Exclude<TurnStatus, 'running' | 'completed'>
      readonly stopReason: string
      readonly usage: Usage | null
    }

// What the events of a turn are told about the session it belongs to
export type Owner = Pick<Session, 'id' | 'projectId'>

export const insertMessage = (
  sql: SqlClient.SqlClient,
  message: {
    readonly sessionId: string
    readonly turnId: string | null
    readonly role: 'user' | 'assistant'
    readonly content: unknown
  },
): Effect.Effect<void, StoreError> =>
  sql`
    INSERT INTO messages (id, session_id, turn_id, role, content_json, created_at)
    VALUES (${uuidv7()}, ${message.sessionId}, ${message.turnId}, ${message.role}, ${JSON.stringify(message.content)}, ${nowIso()})`.pipe(
    Effect.asVoid,
    Effect.mapError(toStoreError),
  )

// The index is the number of turns the session has had, counted by the insert itself
const insertTurn = (
  sql: SqlClient.SqlClient,
  turn: Omit<Turn, 'index'>,
): Effect.Effect<number, StoreError> =>
  sql<{ readonly idx: number }>`
    INSERT INTO turns (id, session_id, idx, prompt_json, status, started_at)
    VALUES (${turn.id}, ${turn.sessionId}, (SELECT COUNT(*) FROM turns WHERE session_id = ${turn.sessionId}), ${JSON.stringify(turn.prompt)}, ${turn.status}, ${turn.startedAt})
    RETURNING idx`.pipe(
    Effect.flatMap(([row]) => Effect.fromNullishOr(row)),
    Effect.map((row) => row.idx),
    Effect.mapError(toStoreError),
  )

// A turn begins with the prompt of the caller, kept as the turn and as the user's message, and announced as that message
export const startTurn = (
  deps: TurnDeps,
  session: Owner,
  input: PromptInput,
): Effect.Effect<Turn, StoreError> =>
  Effect.gen(function* startsTurn() {
    const begun: Omit<Turn, 'index'> = {
      id: uuidv7(),
      sessionId: session.id,
      prompt: input,
      status: 'running',
      stopReason: null,
      usage: null,
      startedAt: nowIso(),
      endedAt: null,
    }
    const index = yield* insertTurn(deps.sql, begun)
    const content = [{ type: 'text', text: input.text }]
    yield* insertMessage(deps.sql, {
      sessionId: session.id,
      turnId: begun.id,
      role: 'user',
      content,
    })
    yield* deps.log.publish({
      type: 'message.user',
      sessionId: session.id,
      projectId: session.projectId,
      turnId: begun.id,
      payload: { text: input.text },
    })
    return { ...begun, index }
  })

// Only a turn that is running can end, and whoever ends it first wins
const claimTurn = (
  sql: SqlClient.SqlClient,
  sessionId: string,
  outcome: Outcome,
): Effect.Effect<TurnRef | undefined, StoreError> =>
  sql<{ readonly id: string; readonly idx: number }>`
    UPDATE turns SET status = ${outcome.status}, stop_reason = ${outcome.stopReason}, usage_json = ${outcome.usage === null ? null : JSON.stringify(outcome.usage)}, ended_at = ${nowIso()}
    WHERE session_id = ${sessionId} AND status = 'running' RETURNING id, idx`.pipe(
    Effect.mapError(toStoreError),
    Effect.map(([row]) => (row === undefined ? undefined : { turnId: row.id, index: row.idx })),
  )

// A completed turn is told with its usage, any other end as an interruption of the turn
const endEvent = (session: Owner, turn: TurnRef, outcome: Outcome): KernelEvent => {
  const ids = { sessionId: session.id, projectId: session.projectId, turnId: turn.turnId }
  const payload = { ...turn, status: outcome.status }
  return outcome.status === 'completed'
    ? {
        type: 'turn.completed',
        ...ids,
        payload: { ...payload, stopReason: outcome.stopReason, usage: outcome.usage },
      }
    : { type: 'turn.interrupted', ...ids, payload }
}

export const finishTurn = (
  deps: TurnDeps,
  session: Owner,
  outcome: Outcome,
): Effect.Effect<TurnRef | undefined, StoreError> =>
  Effect.gen(function* finishesTurn() {
    const turn = yield* claimTurn(deps.sql, session.id, outcome)
    if (turn !== undefined) {
      yield* deps.log.publish(endEvent(session, turn, outcome))
    }
    return turn
  })
