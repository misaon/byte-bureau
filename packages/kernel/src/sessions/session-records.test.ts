import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError } from '../errors.js'
import { sessionOf, startSession } from './session-fixtures.js'
import { sessionLayer } from './session-layer-fixtures.js'
import { SessionManager } from './session-manager.js'
import { claimStatus } from './session-records.js'

// Breaks a column of the session, so the row no longer fits what the manager reads; a CHECK constraint is no excuse
const corrupt = (
  sessionId: string,
  column: string,
  value: string,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* corrupts() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA ignore_check_constraints = ON`
    yield* sql`UPDATE sessions SET ${sql(column)} = ${value} WHERE id = ${sessionId}`
    yield* sql`PRAGMA ignore_check_constraints = OFF`
  })

// A row that is gone cannot break what is read after it
const discard = (sessionId: string): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* discards() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM sessions WHERE id = ${sessionId}`
  })

const BROKEN = [
  ['the employee', 'employee_json', '{}'],
  ['the status', 'status', 'sleeping'],
  ['the workspace', 'workspace_json', '{"path":1}'],
  ['the external reference', 'external_ref', 'not json'],
] as const

it.layer(sessionLayer())('SessionManager records that cannot be read', (suite) => {
  suite.effect.each(BROKEN)(
    'fails with a store error for a session whose %s cannot be read',
    ([, column, value]) =>
      Effect.gen(function* failsOnBrokenRow() {
        const sessions = yield* SessionManager
        const session = yield* startSession()
        yield* corrupt(session.id, column, value)
        const fromGet = yield* Effect.flip(sessions.get(session.id))
        const fromList = yield* Effect.flip(sessions.list())
        assert.ok(fromGet instanceof StoreError && fromList instanceof StoreError)
        yield* discard(session.id)
      }),
  )
})

it.layer(sessionLayer())('SessionManager claims a status', (suite) => {
  suite.effect('moves a session only from the status the caller saw', () =>
    Effect.gen(function* claimsStatus() {
      const sql = yield* SqlClient.SqlClient
      const session = yield* startSession()
      const moved = yield* claimStatus(sql, session, { next: 'running' })
      const stale = yield* claimStatus(sql, session, { next: 'stopped' })
      assert.deepStrictEqual(
        [moved === undefined ? null : moved.status, stale],
        ['running', undefined],
      )
      assert.strictEqual((yield* sessionOf(session.id)).status, 'running')
    }),
  )

  suite.effect(
    'starts a session when it first runs and ends it when it stops, until it resumes',
    () =>
      Effect.gen(function* datesSession() {
        const sql = yield* SqlClient.SqlClient
        const session = yield* startSession()
        const running = yield* Effect.fromNullishOr(
          yield* claimStatus(sql, session, { next: 'running' }),
        )
        const stopped = yield* Effect.fromNullishOr(
          yield* claimStatus(sql, running, { next: 'stopped' }),
        )
        const resumed = yield* Effect.fromNullishOr(
          yield* claimStatus(sql, stopped, { next: 'ready' }),
        )
        assert.deepStrictEqual(
          [session.startedAt, running.startedAt === null, running.endedAt],
          [null, false, null],
        )
        assert.deepStrictEqual(
          [stopped.endedAt === null, resumed.endedAt, resumed.startedAt === running.startedAt],
          [false, null, true],
        )
      }),
  )
})
