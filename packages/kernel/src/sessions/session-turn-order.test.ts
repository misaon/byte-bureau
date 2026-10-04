import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { sessionOf, startSession, typesOf } from './session-fixtures.js'
import { prompted } from './session-prompted-fixtures.js'
import { FINISH, push } from './session-push-fixtures.js'
import { driven } from './session-script-fixtures.js'

const world = driven()

// The status of its session at the moment each end of a turn is stored, kept by the store itself
const watchTurnEnds = Effect.gen(function* watchesTurnEnds() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE IF NOT EXISTS turn_end_seen (session_id TEXT, type TEXT, status TEXT)`
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS turn_end_watch AFTER INSERT ON events
    WHEN NEW.type IN ('turn.completed', 'turn.interrupted')
    BEGIN
      INSERT INTO turn_end_seen SELECT NEW.session_id, NEW.type, status FROM sessions WHERE id = NEW.session_id;
    END`
})

const seenAtEnd = (
  sessionId: string,
): Effect.Effect<readonly unknown[], unknown, SqlClient.SqlClient> =>
  Effect.gen(function* readsSeen() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ readonly type: string; readonly status: string }>`
      SELECT type, status FROM turn_end_seen WHERE session_id = ${sessionId}`
    return rows.map((row) => [row.type, row.status])
  })

it.layer(world.layer)('the end of a turn and the status of its session', (suite) => {
  suite.effect('is told once the session is ready, and the move to ready right after it', () =>
    Effect.gen(function* tellsEndWhenReady() {
      yield* watchTurnEnds
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(world, session)
      yield* push(session.id, agent, FINISH)
      assert.deepStrictEqual(yield* seenAtEnd(session.id), [['turn.completed', 'ready']])
      const types = yield* typesOf(session.id)
      assert.deepStrictEqual(types.slice(types.indexOf('turn.completed')), [
        'turn.completed',
        'session.ready',
        'session.warning',
      ])
    }),
  )

  suite.effect('leaves a session that waited for a usage limit ready when its turn ends', () =>
    Effect.gen(function* readiesPausedSession() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(world, session)
      // Nothing pauses a session yet: the store says what a provider at its limit would make of it
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE sessions SET status = 'paused_usage_limit' WHERE id = ${session.id}`
      yield* push(session.id, agent, { ...FINISH, stopReason: 'interrupted' })
      const types = yield* typesOf(session.id)
      assert.strictEqual((yield* sessionOf(session.id)).status, 'ready')
      assert.deepStrictEqual(types.slice(types.indexOf('turn.interrupted')), [
        'turn.interrupted',
        'session.ready',
        'session.warning',
      ])
    }),
  )
})
