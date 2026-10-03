import type { Ask } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError } from '../errors.js'
import { StoreTest } from '../store/store-test.js'
import { buildAsk } from './ask-build.js'
import { request } from './ask-fixtures.js'
import { claimAnswer, claimCancel, insertAsk, listPending, loadAsk } from './ask-records.js'
import { seedSession } from './ask-service-fixtures.js'

const answered = {
  answer: { selected: ['b'] },
  via: 'cli',
  answeredAt: '2026-10-03T00:00:00.000Z',
} as const

interface Stored {
  readonly sql: SqlClient.SqlClient
  readonly ask: Ask
}

// A pending ask of a seeded session, stored
const stored = (sessionId: string): Effect.Effect<Stored, StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* storesAsk() {
    yield* seedSession(sessionId)
    const sql = yield* SqlClient.SqlClient
    const ask = buildAsk(request(sessionId))
    yield* insertAsk(sql, ask)
    return { sql, ask }
  })

it.layer(StoreTest)('ask records', (suite) => {
  suite.effect('read back as the ask they were stored as, nothing answered yet', () =>
    Effect.gen(function* readsBack() {
      const { sql, ask } = yield* stored('rec-1')
      const record = yield* loadAsk(sql, ask.id)
      assert.deepStrictEqual(record, { ...ask, answer: null, answeredAt: null, answeredVia: null })
      assert.strictEqual(yield* loadAsk(sql, 'nobody'), undefined)
    }),
  )

  suite.effect('are answered by the first claim only', () =>
    Effect.gen(function* claimsOnce() {
      const { sql, ask } = yield* stored('rec-2')
      const first = yield* claimAnswer(sql, ask.id, answered)
      const second = yield* claimAnswer(sql, ask.id, { ...answered, via: 'api' })
      assert.deepStrictEqual(first, {
        ...ask,
        status: 'answered',
        answer: answered.answer,
        answeredAt: answered.answeredAt,
        answeredVia: 'cli',
      })
      assert.strictEqual(second, undefined)
      assert.deepStrictEqual(yield* loadAsk(sql, ask.id), first)
    }),
  )
})

it.layer(StoreTest)('ask records cancelled', (suite) => {
  suite.effect('are cancelled by the first claim only, and an answer cannot follow', () =>
    Effect.gen(function* cancelsOnce() {
      const { sql, ask } = yield* stored('rec-3')
      const cancelled = yield* claimCancel(sql, ask.id)
      assert.deepStrictEqual(cancelled, {
        ...ask,
        status: 'cancelled',
        answer: null,
        answeredAt: null,
        answeredVia: null,
      })
      assert.strictEqual(yield* claimCancel(sql, ask.id), undefined)
      assert.strictEqual(yield* claimAnswer(sql, ask.id, answered), undefined)
    }),
  )

  suite.effect('cannot be cancelled once answered, or claimed when unknown', () =>
    Effect.gen(function* refusesLateCancel() {
      const { sql, ask } = yield* stored('rec-4')
      yield* claimAnswer(sql, ask.id, answered)
      assert.strictEqual(yield* claimCancel(sql, ask.id), undefined)
      assert.strictEqual(yield* claimCancel(sql, 'nobody'), undefined)
      assert.strictEqual(yield* claimAnswer(sql, 'nobody', answered), undefined)
    }),
  )
})

const ids = (records: readonly { readonly id: string }[]): readonly string[] =>
  records.map((record) => record.id)

it.layer(StoreTest)('ask records listing', (suite) => {
  suite.effect('lists the pending ones by creation time, the id deciding between equals', () =>
    Effect.gen(function* listsOldestFirst() {
      const { sql, ask } = yield* stored('rec-5')
      yield* seedSession('rec-6')
      const at = (id: string, createdAt: string, sessionId = 'rec-5'): Ask => ({
        ...ask,
        id,
        sessionId,
        createdAt,
      })
      yield* Effect.all([
        insertAsk(sql, at('b', '2026-10-03T00:00:02.000Z')),
        insertAsk(sql, at('c', '2026-10-03T00:00:01.000Z')),
        insertAsk(sql, at('a', '2026-10-03T00:00:02.000Z')),
        insertAsk(sql, at('d', '2026-10-03T00:00:03.000Z', 'rec-6')),
      ])
      yield* claimAnswer(sql, ask.id, answered)
      assert.deepStrictEqual(ids(yield* listPending(sql)), ['c', 'a', 'b', 'd'])
      assert.deepStrictEqual(ids(yield* listPending(sql, 'rec-6')), ['d'])
    }),
  )

  suite.effect('fail as a store error when a row does not fit the protocol', () =>
    Effect.gen(function* failsOnUnreadableRow() {
      const { sql, ask } = yield* stored('rec-7')
      const second = buildAsk(request('rec-7'))
      yield* insertAsk(sql, second)
      yield* sql`UPDATE asks SET payload_json = 'not json' WHERE id = ${ask.id}`
      yield* sql`UPDATE asks SET answered_via = 'pigeon' WHERE id = ${second.id}`
      assert.instanceOf(yield* Effect.flip(loadAsk(sql, ask.id)), StoreError)
      assert.instanceOf(yield* Effect.flip(loadAsk(sql, second.id)), StoreError)
    }),
  )
})
