import { existsSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { WorkspaceManager } from '../workspace/workspace-manager.js'
import { startSession } from './session-fixtures.js'
import { refusalOf } from './session-helpers.js'
import { sessionLayer } from './session-layers.js'
import { SessionManager } from './session-manager.js'

const SLOW = { BYTEBUREAU_FAKE_SCRIPT: 'slow' }

it.layer(sessionLayer())('SessionManager worktree', (suite) => {
  suite.effect(
    'keeps the worktree locked while a turn runs and frees it when the session stops',
    () =>
      Effect.gen(function* locksWorktree() {
        const sessions = yield* SessionManager
        const workspaces = yield* WorkspaceManager
        const session = yield* startSession({ env: SLOW })
        yield* sessions.prompt(session.id, { text: 'take your time' })
        const handle = yield* Effect.fromNullishOr(session.workspace)
        const refused = yield* refusalOf(workspaces.destroy(handle, { force: true }))
        assert.match(refused, /^locked: /u)
        yield* sessions.stop(session.id)
        yield* workspaces.destroy(handle, { force: true })
        assert.ok(!existsSync(handle.path))
      }),
  )
})

it.layer(sessionLayer())('SessionManager records', (suite) => {
  suite.effect('lists sessions newest first and has none for an id nobody holds', () =>
    Effect.gen(function* listsSessions() {
      const sessions = yield* SessionManager
      const first = yield* startSession({ title: 'first' })
      const second = yield* startSession({ title: 'second' })
      const listed = yield* sessions.list()
      assert.deepStrictEqual(
        listed.slice(0, 2).map((session) => session.id),
        [second.id, first.id],
      )
      assert.strictEqual(yield* sessions.get('nobody'), undefined)
    }),
  )
})
