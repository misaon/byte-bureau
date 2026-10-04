import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { startSession } from './session-fixtures.js'
import { sessionLayer } from './session-layer-fixtures.js'
import { ownerOf } from './session-recover-fixtures.js'
import { claimStatus } from './session-records.js'

// A kernel of another process, which reached for the session on a decision gone stale
const OTHER = { pid: 4242, id: 'other-kernel' }

it.layer(sessionLayer())('the owner a move of the status names', (suite) => {
  suite.effect('changes with the status in one statement, so a refused move names nobody', () =>
    Effect.gen(function* claimsWithStatus() {
      const sql = yield* SqlClient.SqlClient
      const session = yield* startSession()
      const before = yield* ownerOf(session.id)
      // The session moved on since it was read: the stale move to running is refused
      yield* claimStatus(sql, session, { next: 'stopped' })
      const refused = yield* claimStatus(sql, session, { next: 'running', owner: OTHER })
      assert.deepStrictEqual([refused, yield* ownerOf(session.id)], [undefined, before])
    }),
  )

  suite.effect('names the kernel of a move that goes through', () =>
    Effect.gen(function* claimsOnMove() {
      const sql = yield* SqlClient.SqlClient
      const session = yield* startSession()
      yield* claimStatus(sql, session, { next: 'running', owner: OTHER })
      assert.deepStrictEqual(yield* ownerOf(session.id), { pid: 4242, instance: 'other-kernel' })
    }),
  )
})
