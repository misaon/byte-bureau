import type { EventEnvelope } from '@bytebureau/protocol'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { vi } from 'vitest'
import { AskError, toStoreError, type StoreError } from '../errors.js'
import { EventLog, EventLogLive } from '../events/event-log.js'
import { StoreTest } from '../store/store-test.js'
import { AskServiceLive } from './ask-service.js'

// The service over the real event log and an in-memory store
export const TestLayer = AskServiceLive.pipe(
  Layer.provideMerge(EventLogLive),
  Layer.provideMerge(StoreTest),
)

// A session row, and the project it needs, so asks can point at it
export const seedSession = (id: string): Effect.Effect<void, StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* seedsSession() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at)
      VALUES ('p', 'p', '/p', 'main', '{}', 't', 't') ON CONFLICT DO NOTHING`
    yield* sql`
      INSERT INTO sessions (id, project_id, title, employee_json, provider_id, workspace_json, status, created_at)
      VALUES (${id}, 'p', 't', '{}', 'fake', '{}', 'running', 't')`
  }).pipe(Effect.mapError(toStoreError))

// A turn of a seeded session, for the asks that name one
export const seedTurn = (
  sessionId: string,
  turnId: string,
): Effect.Effect<void, StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* seedsTurn() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO turns (id, session_id, idx, prompt_json, status, started_at)
      VALUES (${turnId}, ${sessionId}, 0, '{}', 'running', 't')`
  }).pipe(Effect.mapError(toStoreError))

// The system clock stands at the instant while the effect runs; the test clock is not touched
export const atSystemTime = <Value, Failure, Requirements>(
  instant: number,
  effect: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, Failure, Requirements> =>
  Effect.suspend(() => {
    vi.setSystemTime(instant)
    return effect
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        vi.useRealTimers()
      }),
    ),
  )

// A store that lost its asks table, for the failures that causes
export const dropAsks: Effect.Effect<void, StoreError, SqlClient.SqlClient> = Effect.gen(
  function* dropsAsks() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP TABLE asks`
  },
).pipe(Effect.mapError(toStoreError))

interface StoredAsk {
  readonly session_id: string
  readonly turn_id: string | null
  readonly kind: string
  readonly status: string
  readonly recommendation_source: string
  readonly deadline_at: string | null
  readonly answer_json: string | null
  readonly answered_at: string | null
  readonly answered_via: string | null
}

// The row of an ask as the table holds it
export const rowOf = (askId: string): Effect.Effect<StoredAsk, StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* readsRow() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<StoredAsk>`
      SELECT session_id, turn_id, kind, status, recommendation_source, deadline_at, answer_json, answered_at, answered_via
      FROM asks WHERE id = ${askId}`
    return yield* Effect.fromNullishOr(rows[0])
  }).pipe(Effect.mapError(toStoreError))

export interface SeenEvent {
  readonly type: string
  readonly turnId?: string
  readonly payload: unknown
}

// A turn id is left out of an event that has none, so an expectation need not spell out a missing one
const seen = (event: EventEnvelope): SeenEvent => ({
  type: event.type,
  ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
  payload: event.payload,
})

// What the event log holds for a session, oldest first
export const eventsOf = (
  sessionId: string,
): Effect.Effect<readonly SeenEvent[], StoreError, EventLog> =>
  Effect.gen(function* readsEvents() {
    const log = yield* EventLog
    const events = yield* log.read({ sessionId }, { from: 0 })
    return events.map((event) => seen(event))
  })

// The code of an ask error, the word store for any other failure
export const codeOf = (error: AskError | StoreError): string =>
  error instanceof AskError ? error.code : 'store'

// The reason of an ask error, nothing for any other failure
export const reasonOf = (error: AskError | StoreError): string =>
  error instanceof AskError ? error.reason : ''

// Lets the fibers that are ready run; a timer that fired needs a few turns to finish its work
export const flush: Effect.Effect<void> = Effect.forEach(
  Array.from({ length: 20 }),
  () => Effect.yieldNow,
  { discard: true },
)
