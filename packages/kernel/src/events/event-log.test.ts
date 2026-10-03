import type { EventEnvelope, KernelEvent } from '@bytebureau/protocol'
import { assert, describe, expect, it } from '@effect/vitest'
import { Context, Effect, Exit, Fiber, Latch, Layer, Scope, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError } from '../errors.js'
import { StoreTest } from '../store/store-test.js'
import {
  EventLog,
  EventLogLive,
  matches,
  type EventFilter,
  type EventLogShape,
} from './event-log.js'

const TestLayer = EventLogLive.pipe(Layer.provideMerge(StoreTest))

const created = (sessionId: string): KernelEvent => ({
  type: 'session.created',
  sessionId,
  payload: { status: 'created', title: 'Fix the build', employeeId: 'dev', providerId: 'fake' },
})

const provisioning = (sessionId: string): KernelEvent => ({
  type: 'session.provisioning',
  sessionId,
  payload: { status: 'provisioning' },
})

const ready = (sessionId: string): KernelEvent => ({
  type: 'session.ready',
  sessionId,
  payload: { status: 'ready' },
})

const delta = (sessionId: string, text: string): KernelEvent => ({
  type: 'message.assistant.delta',
  sessionId,
  payload: { kind: 'text', text },
})

// The subscriber has subscribed and replayed up to its first wait when this returns
const collect = (
  log: EventLogShape,
  filter: EventFilter,
  count: number,
): Effect.Effect<Fiber.Fiber<EventEnvelope[], StoreError>> =>
  Effect.forkChild(log.subscribe(filter).pipe(Stream.take(count), Stream.runCollect), {
    startImmediately: true,
  })

describe(matches, () => {
  const envelope: EventEnvelope = {
    seq: 1,
    id: 'x',
    ts: 't',
    type: 'tool.started',
    sessionId: 's',
    projectId: 'p',
    payload: {},
  }

  it('filters by session, project and type', () => {
    expect(matches({ sessionId: 's' }, envelope)).toBe(true)
    expect(matches({ types: ['tool.started'] }, envelope)).toBe(true)
    expect(matches({ projectId: 'other' }, envelope)).toBe(false)
    expect(matches({ sessionId: 'other' }, envelope)).toBe(false)
    expect(matches({ types: ['tool.completed'] }, envelope)).toBe(false)
  })

  it('lets every envelope through an empty filter', () => {
    expect(matches({}, envelope)).toBe(true)
    expect(matches({ projectId: 'p', sessionId: 's', types: ['tool.started'] }, envelope)).toBe(
      true,
    )
  })

  it('rejects ephemeral envelopes only when ephemeral is false', () => {
    const live: EventEnvelope = { ...envelope, seq: 0, type: 'heartbeat' }
    expect(matches({ ephemeral: false }, live)).toBe(false)
    expect(matches({ ephemeral: true }, live)).toBe(true)
    expect(matches({}, live)).toBe(true)
    expect(matches({ ephemeral: false }, envelope)).toBe(true)
  })
})

it.layer(TestLayer)('EventLog publish', (suite) => {
  suite.effect('assigns increasing seq to durable events and none to ephemeral ones', () =>
    Effect.gen(function* assignsSeq() {
      const log = yield* EventLog
      const first = yield* log.publish(created('s1'))
      const chunk = yield* log.publish(delta('s1', 'x'))
      const second = yield* log.publish(ready('s1'))
      assert.ok(first.seq > 0)
      assert.ok(second.seq > first.seq)
      assert.strictEqual(chunk.seq, 0)
      const stored = yield* log.read({ sessionId: 's1' }, { from: 0 })
      assert.deepStrictEqual(
        stored.map((event) => event.type),
        ['session.created', 'session.ready'],
      )
    }),
  )

  suite.effect('stores the envelope as published and omits the ids an event lacks', () =>
    Effect.gen(function* roundTrips() {
      const log = yield* EventLog
      const scoped = yield* log.publish({
        type: 'tool.started',
        projectId: 'p1',
        sessionId: 's2',
        turnId: 't1',
        payload: { id: 'call-1', name: 'Read', kind: 'builtin', input: { path: 'a.ts' } },
      })
      const bare = yield* log.publish({ type: 'profile.removed', payload: { profileId: 'x' } })
      const stored = yield* log.read({}, { from: scoped.seq - 1, to: bare.seq })
      assert.deepStrictEqual(stored, [scoped, bare])
      assert.deepStrictEqual(Object.keys(bare).toSorted(), ['id', 'payload', 'seq', 'ts', 'type'])
    }),
  )
})

it.layer(TestLayer)('EventLog read', (suite) => {
  suite.effect('filters by project and session', () =>
    Effect.gen(function* readsScoped() {
      const log = yield* EventLog
      const first = yield* log.publish({ ...created('s3'), projectId: 'p3' })
      const second = yield* log.publish({ ...created('s3b'), projectId: 'p3' })
      const other = yield* log.publish({ ...created('s4'), projectId: 'p4' })
      assert.deepStrictEqual(yield* log.read({ projectId: 'p3' }, { from: 0 }), [first, second])
      assert.deepStrictEqual(yield* log.read({ projectId: 'p4' }, { from: 0 }), [other])
      assert.deepStrictEqual(yield* log.read({ sessionId: 's3' }, { from: 0 }), [first])
      const both = { projectId: 'p4', sessionId: 's3' }
      assert.deepStrictEqual(yield* log.read(both, { from: 0 }), [])
    }),
  )

  suite.effect('filters by type and keeps to the range, after from and up to to', () =>
    Effect.gen(function* readsRange() {
      const log = yield* EventLog
      const first = yield* log.publish(created('s12'))
      const second = yield* log.publish(provisioning('s12'))
      const third = yield* log.publish(ready('s12'))
      const types = ['session.provisioning', 'session.ready']
      const typed = yield* log.read({ sessionId: 's12', types }, { from: 0 })
      assert.deepStrictEqual(typed, [second, third])
      const window = yield* log.read({ sessionId: 's12' }, { from: first.seq, to: second.seq })
      assert.deepStrictEqual(window, [second])
    }),
  )

  suite.effect('returns nothing when no stored event matches', () =>
    Effect.gen(function* readsNothing() {
      const log = yield* EventLog
      const only = yield* log.publish(created('s5'))
      assert.deepStrictEqual(yield* log.read({ sessionId: 'nobody' }, { from: 0 }), [])
      assert.deepStrictEqual(yield* log.read({ projectId: 'nowhere' }, { from: 0 }), [])
      assert.deepStrictEqual(yield* log.read({ types: ['tool.failed'] }, { from: 0 }), [])
      assert.deepStrictEqual(yield* log.read({ sessionId: 's5' }, { from: only.seq }), [])
    }),
  )
})

it.layer(TestLayer)('EventLog replay and live', (suite) => {
  suite.effect('replays from since and continues live without gaps or duplicates', () =>
    Effect.gen(function* replaysThenLive() {
      const log = yield* EventLog
      const first = yield* log.publish(created('s6'))
      const second = yield* log.publish(provisioning('s6'))
      const collected = yield* collect(log, { sessionId: 's6', since: first.seq }, 3)
      // The subscriber already runs up to its first wait; the two turns are margin
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      const third = yield* log.publish(ready('s6'))
      const fourth = yield* log.publish(delta('s6', 'live'))
      assert.deepStrictEqual(yield* Fiber.join(collected), [second, third, fourth])
      assert.ok(second.seq > first.seq && third.seq > second.seq)
    }),
  )

  suite.effect('keeps what is published while the replay is still being consumed', () =>
    Effect.gen(function* publishesDuringReplay() {
      const log = yield* EventLog
      const first = yield* log.publish(created('s7'))
      const [replaying, resume] = yield* Effect.all([Latch.make(), Latch.make()])
      const hold = Effect.andThen(replaying.open, resume.await)
      const stream = log.subscribe({ sessionId: 's7' }).pipe(Stream.tap(() => hold))
      const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 2)))
      yield* replaying.await
      const second = yield* log.publish(ready('s7'))
      yield* resume.open
      assert.deepStrictEqual(yield* Fiber.join(collected), [first, second])
    }),
  )
})

it.layer(TestLayer)('EventLog overlap', (suite) => {
  suite.effect('delivers an event once when the replay and the live feed both carry it', () =>
    Effect.gen(function* deliversOnce() {
      const [sql, log, commit, replayed] = yield* Effect.all([
        SqlClient.SqlClient,
        EventLog,
        Latch.make(),
        Latch.make(),
      ])
      // The open transaction holds the connection, so the replay query waits for its commit
      const publishing = Effect.andThen(commit.await, log.publish(ready('s8')))
      const writer = yield* Effect.forkChild(sql.withTransaction(publishing), {
        startImmediately: true,
      })
      const stream = log.subscribe({ sessionId: 's8' }).pipe(Stream.tap(() => replayed.open))
      const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 2)), {
        startImmediately: true,
      })
      yield* commit.open
      const second = yield* Fiber.join(writer)
      yield* replayed.await
      const third = yield* log.publish(provisioning('s8'))
      assert.deepStrictEqual(yield* Fiber.join(collected), [second, third])
    }),
  )
})

it.layer(TestLayer)('EventLog live delivery', (suite) => {
  suite.effect('skips live events at or below since', () =>
    Effect.gen(function* skipsBelowSince() {
      const log = yield* EventLog
      const first = yield* log.publish(created('s9'))
      const upToDate = yield* collect(log, { sessionId: 's9', since: first.seq }, 1)
      const ahead = yield* collect(log, { sessionId: 's9', since: first.seq + 100 }, 1)
      const second = yield* log.publish(ready('s9'))
      const chunk = yield* log.publish(delta('s9', 'x'))
      assert.deepStrictEqual(yield* Fiber.join(upToDate), [second])
      assert.deepStrictEqual(yield* Fiber.join(ahead), [chunk])
    }),
  )

  suite.effect('fans ephemeral events out to live subscribers only', () =>
    Effect.gen(function* fansOutEphemeral() {
      const log = yield* EventLog
      yield* log.publish(delta('s10', 'early'))
      const everything = yield* collect(log, { sessionId: 's10' }, 2)
      const durableOnly = yield* collect(log, { sessionId: 's10', ephemeral: false }, 1)
      yield* log.publish(ready('elsewhere'))
      const chunk = yield* log.publish(delta('s10', 'live'))
      const second = yield* log.publish(ready('s10'))
      assert.deepStrictEqual(yield* Fiber.join(everything), [chunk, second])
      assert.deepStrictEqual(yield* Fiber.join(durableOnly), [second])
    }),
  )
})

// The fiber waits on the hub with nothing to deliver; shutting the hub down ends it normally, not by interruption
it.effect('ends the subscriptions that wait for events when the layer is released', () =>
  Effect.gen(function* endsParkedSubscription() {
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(TestLayer, scope)
    const parked = yield* collect(Context.get(context, EventLog), { sessionId: 's13' }, 1)
    yield* Scope.close(scope, Exit.void)
    assert.deepStrictEqual(yield* Fiber.join(parked), [])
  }),
)

it.effect('reports a failing statement as a StoreError from publish, read and subscribe', () =>
  Effect.gen(function* failsWithStoreError() {
    const sql = yield* SqlClient.SqlClient
    const log = yield* EventLog
    yield* sql`DROP TABLE events`
    const failures = [
      yield* Effect.flip(log.publish(created('s11'))),
      yield* Effect.flip(log.read({}, { from: 0 })),
      yield* Effect.flip(Stream.runCollect(log.subscribe({}))),
    ]
    for (const failure of failures) {
      assert.instanceOf(failure, StoreError)
    }
  }).pipe(Effect.provide(TestLayer)),
)
