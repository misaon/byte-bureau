import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { sessionOf, startSession, typesOf } from './session-fixtures.js'
import { refusalOf } from './session-helper-fixtures.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import { FINISH, push } from './session-push-fixtures.js'
import { driven } from './session-script-fixtures.js'

const AGENT = { providerId: 'scripted' } as const

const attached = driven()

it.layer(attached.layer)('SessionManager interrupt of an agent between turns', (suite) => {
  suite.effect('refuses a session whose agent is still attached but has no turn at work', () =>
    Effect.gen(function* refusesBetweenTurns() {
      const sessions = yield* SessionManager
      const session = yield* startSession(AGENT)
      const { agent } = yield* prompted(attached, session)
      yield* push(session.id, agent, FINISH)
      const refused = yield* refusalOf(sessions.interrupt(session.id))
      assert.strictEqual(
        refused,
        'invalid_transition: cannot interrupt a ready session: no turn of it is at work',
      )
      assert.strictEqual((yield* sessionOf(session.id)).status, 'ready')
      assert.notInclude(yield* typesOf(session.id), 'turn.interrupted')
    }),
  )
})
