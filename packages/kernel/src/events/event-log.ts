import { type EventEnvelope, isEphemeral, type KernelEvent } from '@bytebureau/protocol'
import { Context, Effect, Layer, PubSub, Stream } from 'effect'
import { SqlClient, type Statement } from 'effect/sql'
import { StoreError } from '../errors.js'
import { nowIso, uuidv7 } from '../ids.js'

export interface EventFilter {
  readonly sessionId?: string | undefined
  readonly projectId?: string | undefined
  readonly types?: readonly string[] | undefined
  readonly since?: number | undefined
  readonly ephemeral?: boolean | undefined
}

interface EventRange {
  readonly from: number
  readonly to?: number
}

export interface EventLogShape {
  readonly publish: (event: KernelEvent) => Effect.Effect<EventEnvelope, StoreError>
  readonly subscribe: (filter: EventFilter) => Stream.Stream<EventEnvelope, StoreError>
  readonly read: (
    filter: EventFilter,
    range: EventRange,
  ) => Effect.Effect<readonly EventEnvelope[], StoreError>
}

export class EventLog extends Context.Service<EventLog, EventLogShape>()('bb/EventLog') {}

export function matches(filter: EventFilter, event: EventEnvelope): boolean {
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) {
    return false
  }
  if (filter.projectId !== undefined && event.projectId !== filter.projectId) {
    return false
  }
  if (filter.types !== undefined && !filter.types.includes(event.type)) {
    return false
  }
  return filter.ephemeral !== false || event.seq !== 0
}

interface Row {
  readonly seq: number
  readonly id: string
  readonly ts: string
  readonly type: string
  readonly project_id: string | null
  readonly session_id: string | null
  readonly turn_id: string | null
  readonly payload_json: string
}

// The protocol declares the ids optional keys, so an absent one is left out and never set to undefined
const fromRow = (row: Row): EventEnvelope => ({
  seq: row.seq,
  id: row.id,
  ts: row.ts,
  type: row.type,
  ...(row.project_id === null ? {} : { projectId: row.project_id }),
  ...(row.session_id === null ? {} : { sessionId: row.session_id }),
  ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
  payload: JSON.parse(row.payload_json),
})

const toStoreError = (cause: unknown): StoreError => new StoreError({ cause })

// RETURNING yields the one new row; a missing row fails the publish instead of passing for an ephemeral seq 0
const insertEvent = (
  sql: SqlClient.SqlClient,
  event: KernelEvent,
  stamp: { readonly id: string; readonly ts: string },
): Effect.Effect<number, StoreError> =>
  sql<Pick<Row, 'seq'>>`
    INSERT INTO events (id, ts, type, project_id, session_id, turn_id, payload_json)
    VALUES (${stamp.id}, ${stamp.ts}, ${event.type}, ${event.projectId ?? null}, ${event.sessionId ?? null}, ${event.turnId ?? null}, ${JSON.stringify(event.payload)})
    RETURNING seq`.pipe(
    Effect.flatMap(([row]) => Effect.fromNullishOr(row)),
    Effect.map((row) => row.seq),
    Effect.mapError(toStoreError),
  )

// Session and project narrow the query itself, so the (session_id, seq) and (project_id, seq) indexes serve it
const conditions = (
  sql: SqlClient.SqlClient,
  filter: EventFilter,
  range: EventRange,
): readonly Statement.Fragment[] => [
  sql`seq > ${range.from}`,
  ...(range.to === undefined ? [] : [sql`seq <= ${range.to}`]),
  ...(filter.sessionId === undefined ? [] : [sql`session_id = ${filter.sessionId}`]),
  ...(filter.projectId === undefined ? [] : [sql`project_id = ${filter.projectId}`]),
]

const makeRead =
  (sql: SqlClient.SqlClient): EventLogShape['read'] =>
  (filter, range) =>
    sql<Row>`
      SELECT seq, id, ts, type, project_id, session_id, turn_id, payload_json FROM events
      WHERE ${sql.and(conditions(sql, filter, range))} ORDER BY seq`.pipe(
      Effect.map((rows) =>
        rows.map((row) => fromRow(row)).filter((event) => matches(filter, event)),
      ),
      Effect.mapError(toStoreError),
    )

const makePublish =
  (sql: SqlClient.SqlClient, hub: PubSub.PubSub<EventEnvelope>): EventLogShape['publish'] =>
  (event) =>
    Effect.gen(function* publishEvent() {
      const stamp = { id: uuidv7(), ts: nowIso() }
      const seq = isEphemeral(event.type) ? 0 : yield* insertEvent(sql, event, stamp)
      const envelope: EventEnvelope = {
        seq,
        ...stamp,
        type: event.type,
        ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        payload: event.payload,
      }
      yield* PubSub.publish(hub, envelope)
      return envelope
    })

// The subscription opens before the replay is read, so nothing published meanwhile is lost
// An event can then arrive twice; the live part drops those the replay already carried
const makeSubscribe =
  (read: EventLogShape['read'], hub: PubSub.PubSub<EventEnvelope>): EventLogShape['subscribe'] =>
  (filter) =>
    Stream.unwrap(
      Effect.gen(function* openSubscription() {
        const subscription = yield* PubSub.subscribe(hub)
        const since = filter.since ?? 0
        const replayed = yield* read(filter, { from: since })
        const last = replayed.at(-1)
        const replayedTo = last === undefined ? since : last.seq
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (event) => matches(filter, event) && (event.seq === 0 || event.seq > replayedTo),
          ),
        )
        return Stream.concat(Stream.fromIterable(replayed), live)
      }),
    )

const make = Effect.gen(function* makeEventLog() {
  const sql = yield* SqlClient.SqlClient
  const hub = yield* PubSub.unbounded<EventEnvelope>()
  const read = makeRead(sql)
  return EventLog.of({ publish: makePublish(sql, hub), subscribe: makeSubscribe(read, hub), read })
})

export const EventLogLive: Layer.Layer<EventLog, never, SqlClient.SqlClient> = Layer.effect(
  EventLog,
  make,
)
