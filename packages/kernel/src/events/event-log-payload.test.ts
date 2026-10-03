import type { KernelEvent } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Layer, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError } from '../errors.js'
import { StoreTest } from '../store/store-test.js'
import { EventLog, EventLogLive } from './event-log.js'

const TestLayer = EventLogLive.pipe(Layer.provideMerge(StoreTest))

// A tool call whose input is whatever the test needs to store
const withInput = (sessionId: string, input: unknown): KernelEvent => ({
  type: 'tool.started',
  sessionId,
  payload: { id: 't', name: 'Bash', kind: 'bash', input },
})

const NESTED = {
  nothing: null,
  zero: 0,
  empty: '',
  flag: false,
  list: [1, 'two', null, [true, []], { deep: { deeper: null } }],
}

it.layer(TestLayer)('EventLog payloads', (suite) => {
  suite.effect('stores, reads and replays null, primitives and arrays nested in a payload', () =>
    Effect.gen(function* keepsNestedValues() {
      const log = yield* EventLog
      const content = [null, 7, 'text', [false], {}]
      yield* log.publish(withInput('nested', NESTED))
      yield* log.publish({
        type: 'message.assistant.completed',
        sessionId: 'nested',
        payload: { text: 'x', content },
      })
      const read = yield* log.read({ sessionId: 'nested' }, { from: 0 })
      const replayed = yield* Stream.runCollect(
        log.subscribe({ sessionId: 'nested', since: 0 }).pipe(Stream.take(2)),
      )
      const expected = [
        { id: 't', name: 'Bash', kind: 'bash', input: NESTED },
        { text: 'x', content },
      ]
      assert.deepStrictEqual(
        [read.map((event) => event.payload), replayed.map((event) => event.payload)],
        [expected, expected],
      )
    }),
  )
})

it.layer(TestLayer)('EventLog payloads that cannot be stored or read', (suite) => {
  suite.effect('refuses a payload JSON cannot hold with a StoreError, and stores nothing', () =>
    Effect.gen(function* refusesPayload() {
      const log = yield* EventLog
      const cyclic: Record<string, unknown> = {}
      cyclic['self'] = cyclic
      const failures = [
        yield* Effect.flip(log.publish(withInput('refused', { size: 10n }))),
        yield* Effect.flip(log.publish(withInput('refused', cyclic))),
      ]
      assert.ok(failures.every((failure) => failure instanceof StoreError))
      assert.match(
        failures.map((failure) => failure.message).join(' | '),
        /cannot be stored as JSON/u,
      )
      assert.deepStrictEqual(yield* log.read({ sessionId: 'refused' }, { from: 0 }), [])
    }),
  )

  suite.effect(
    'fails a read and a replay with a StoreError that names a row whose payload is not JSON',
    () =>
      Effect.gen(function* failsOnCorruptRow() {
        const log = yield* EventLog
        const sql = yield* SqlClient.SqlClient
        const stored = yield* log.publish(withInput('corrupt', null))
        yield* sql`UPDATE events SET payload_json = 'not json' WHERE seq = ${stored.seq}`
        const fromRead = yield* Effect.flip(log.read({ sessionId: 'corrupt' }, { from: 0 }))
        const fromReplay = yield* Effect.flip(
          Stream.runCollect(log.subscribe({ sessionId: 'corrupt', since: 0 })),
        )
        for (const failure of [fromRead, fromReplay]) {
          assert.instanceOf(failure, StoreError)
          assert.strictEqual(failure.message, `the payload of event ${stored.seq} is not JSON`)
        }
      }),
  )
})
