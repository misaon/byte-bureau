import { type EventEnvelope, isEphemeral, type KernelEvent } from '@bytebureau/protocol'
import { Context, Effect, Layer, PubSub, Stream } from 'effect'
import { SqlClient, type Statement } from 'effect/sql'
import { StoreError, toStoreError } from '../errors.js'
import { nowIso, uuidv7 } from '../ids.js'
import { redactValue } from '../logging/redact-value.js'

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

const unreadable =
  (seq: number): ((cause: unknown) => StoreError) =>
  (cause) =>
    new StoreError({ cause: new Error(`the payload of event ${seq} is not JSON`, { cause }) })

// The protocol declares the ids optional keys, so an absent one is left out and never set to undefined
// A row whose payload is not JSON is a failure of the store that names the row, not a defect
const fromRow = (row: Row): Effect.Effect<EventEnvelope, StoreError> =>
  Effect.try({
    try: (): unknown => JSON.parse(row.payload_json),
    catch: unreadable(row.seq),
  }).pipe(
    Effect.map((payload) => ({
      seq: row.seq,
      id: row.id,
      ts: row.ts,
      type: row.type,
      ...(row.project_id === null ? {} : { projectId: row.project_id }),
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
      payload,
    })),
  )

// An event as the log keeps and fans it out: its payload is the redacted copy, which the catalogue no longer types
type SafeEvent = Omit<KernelEvent, 'payload'> & { readonly payload: unknown }

// A payload JSON cannot hold, such as a bigint or a cycle, is refused before anything is stored
const payloadJson = (event: SafeEvent): Effect.Effect<string, StoreError> =>
  Effect.try({
    try: () => JSON.stringify(event.payload),
    catch: (cause) =>
      new StoreError({
        cause: new Error(`the payload of a ${event.type} event cannot be stored as JSON`, {
          cause,
        }),
      }),
  })

// RETURNING yields the one new row; a missing row fails the publish instead of passing for an ephemeral seq 0
const insertEvent = (
  sql: SqlClient.SqlClient,
  event: SafeEvent,
  stamp: { readonly id: string; readonly ts: string },
): Effect.Effect<number, StoreError> =>
  Effect.flatMap(payloadJson(event), (json) =>
    sql<Pick<Row, 'seq'>>`
      INSERT INTO events (id, ts, type, project_id, session_id, turn_id, payload_json)
      VALUES (${stamp.id}, ${stamp.ts}, ${event.type}, ${event.projectId ?? null}, ${event.sessionId ?? null}, ${event.turnId ?? null}, ${json})
      RETURNING seq`.pipe(
      Effect.flatMap(([row]) => Effect.fromNullishOr(row)),
      Effect.map((row) => row.seq),
      Effect.mapError(toStoreError),
    ),
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
      Effect.mapError(toStoreError),
      Effect.flatMap((rows) => Effect.all(rows.map((row) => fromRow(row)))),
      Effect.map((events) => events.filter((event) => matches(filter, event))),
    )

// Nothing may interrupt the steps from the insert on: a stored row that no live subscriber is offered would be seen only by a replay
// The payload is redacted once, here, before it is stored or fanned out (ADR-0012)
const makePublish =
  (sql: SqlClient.SqlClient, hub: PubSub.PubSub<EventEnvelope>): EventLogShape['publish'] =>
  (event) =>
    Effect.gen(function* publishEvent() {
      const safe: SafeEvent = { ...event, payload: redactValue(event.payload) }
      const stamp = { id: uuidv7(), ts: nowIso() }
      const seq = isEphemeral(safe.type) ? 0 : yield* insertEvent(sql, safe, stamp)
      const envelope: EventEnvelope = {
        seq,
        ...stamp,
        type: safe.type,
        ...(safe.projectId === undefined ? {} : { projectId: safe.projectId }),
        ...(safe.sessionId === undefined ? {} : { sessionId: safe.sessionId }),
        ...(safe.turnId === undefined ? {} : { turnId: safe.turnId }),
        payload: safe.payload,
      }
      yield* PubSub.publish(hub, envelope)
      return envelope
    }).pipe(Effect.uninterruptible)

// The seq of the last durable event stored, 0 for an empty log
const makeHead = (sql: SqlClient.SqlClient): Effect.Effect<number, StoreError> =>
  sql<{ readonly head: number }>`SELECT COALESCE(MAX(seq), 0) AS head FROM events`.pipe(
    Effect.mapError(toStoreError),
    Effect.map(([row]) => (row === undefined ? 0 : row.head)),
  )

// The subscription opens before the replay is read, so nothing published meanwhile is lost
// An event can then arrive twice; the live part drops those the replay already carried
// An ephemeral event published during the replay waits in the subscription, so it arrives after the replayed rows
// With nothing to replay the live part starts after the head of the log, read first: a since above it does not hold back what comes next
const makeSubscribe =
  (
    read: EventLogShape['read'],
    head: Effect.Effect<number, StoreError>,
    hub: PubSub.PubSub<EventEnvelope>,
  ): EventLogShape['subscribe'] =>
  (filter) =>
    Stream.unwrap(
      Effect.gen(function* openSubscription() {
        const subscription = yield* PubSub.subscribe(hub)
        const stored = yield* head
        const replayed = yield* read(filter, { from: filter.since ?? 0 })
        const last = replayed.at(-1)
        const replayedTo = last === undefined ? stored : last.seq
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (event) => matches(filter, event) && (event.seq === 0 || event.seq > replayedTo),
          ),
        )
        return Stream.concat(Stream.fromIterable(replayed), live)
      }),
    )

// Releasing the layer shuts the hub down, which ends the subscriptions that wait on it as if the stream had run out
const make = Effect.gen(function* makeEventLog() {
  const sql = yield* SqlClient.SqlClient
  const hub = yield* PubSub.unbounded<EventEnvelope>()
  yield* Effect.addFinalizer(() => PubSub.shutdown(hub))
  const read = makeRead(sql)
  return EventLog.of({
    publish: makePublish(sql, hub),
    subscribe: makeSubscribe(read, makeHead(sql), hub),
    read,
  })
})

export const EventLogLive: Layer.Layer<EventLog, never, SqlClient.SqlClient> = Layer.effect(
  EventLog,
  make,
)
