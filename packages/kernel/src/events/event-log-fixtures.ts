import type { EventEnvelope, KernelEvent } from '@bytebureau/protocol'
import { Context, Effect, Latch, Layer, Stream, type Fiber, type Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import type { StoreError } from '../errors.js'
import { StoreTest } from '../store/store-test.js'
import { EventLog, EventLogLive, type EventFilter, type EventLogShape } from './event-log.js'

// A statement that reaches the gate opens entered and waits until the test opens release
export interface Gate {
  readonly entered: Latch.Latch
  readonly release: Latch.Latch
}

export const makeGate: Effect.Effect<Gate> = Effect.map(
  Effect.all([Latch.make(), Latch.make()]),
  ([entered, release]) => ({ entered, release }),
)

// The text of a tagged statement with its values, for telling one statement from another
const textOf = (args: readonly unknown[]): string => {
  const [strings, ...values] = args
  const parts: readonly unknown[] = Array.isArray(strings) ? strings : []
  return [...parts, ...values].map(String).join(' ')
}

const stopAt = (gate: Gate): Effect.Effect<void> =>
  Effect.andThen(gate.entered.open, gate.release.await)

export interface GatedStatement {
  readonly marker: string
  readonly after: boolean
}

// The statements whose text holds the marker stop at the gate, before they run or once they have run
const gated = (
  sql: SqlClient.SqlClient,
  { marker, after }: GatedStatement,
  gate: Gate,
): SqlClient.SqlClient =>
  new Proxy(sql, {
    apply: (target, self: unknown, args: unknown[]): unknown => {
      const statement: unknown = Reflect.apply(target, self, args)
      if (!textOf(args).includes(marker) || !Effect.isEffect(statement)) {
        return statement
      }
      return after
        ? Effect.tap(statement, () => stopAt(gate))
        : Effect.andThen(stopAt(gate), statement)
    },
  })

// An event log over the in-memory store whose statements with the marker stop at the gate; it lives as long as the test
export const gatedLog = (
  statement: GatedStatement,
  gate: Gate,
): Effect.Effect<EventLogShape, never, Scope.Scope> =>
  Effect.gen(function* buildsGatedLog() {
    const sql = Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function* gatesClient() {
        return gated(yield* SqlClient.SqlClient, statement, gate)
      }),
    )
    const layer = EventLogLive.pipe(Layer.provide(sql), Layer.provide(StoreTest))
    const context = yield* Layer.build(layer)
    return Context.get(context, EventLog)
  })

// A publish that stops at the gate: the fiber, once the statement has reached it
export const heldAtGate = (
  publishing: Effect.Effect<EventEnvelope, StoreError>,
  gate: Gate,
): Effect.Effect<Fiber.Fiber<EventEnvelope, StoreError>> =>
  Effect.gen(function* holdsPublish() {
    const fiber = yield* Effect.forkChild(publishing, { startImmediately: true })
    yield* gate.entered.await
    return fiber
  })

// A tool call of the session s, told apart by its id
export const toolCall = (id: string): KernelEvent => ({
  type: 'tool.started',
  sessionId: 's',
  payload: { id, name: 'Bash', kind: 'bash', input: null },
})

export const textDelta = (text: string): KernelEvent => ({
  type: 'message.assistant.delta',
  sessionId: 's',
  payload: { kind: 'text', text },
})

// The tool call id, or the text of a delta, an envelope carries
export const labelOf = (envelope: EventEnvelope): string => {
  const { payload } = envelope
  const id: unknown =
    typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'id') : undefined
  const text: unknown =
    typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'text') : undefined
  return String(id ?? text)
}

// The subscriber has subscribed, and is reading its replay or waiting, when this returns
export const subscriber = (
  log: EventLogShape,
  filter: EventFilter,
  count: number,
): Effect.Effect<Fiber.Fiber<EventEnvelope[], StoreError>> =>
  Effect.forkChild(log.subscribe(filter).pipe(Stream.take(count), Stream.runCollect), {
    startImmediately: true,
  })
