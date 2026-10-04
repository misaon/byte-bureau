import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { sessionOf, startSession } from '../sessions/session-fixtures.js'
import { sessionLayer } from '../sessions/session-layer-fixtures.js'
import { SessionManager } from '../sessions/session-manager.js'
import { codeOf, loadedProfiles } from './profile-fixtures.js'

it.layer(sessionLayer())('ProfileService and the sessions that run under a profile', (suite) => {
  suite.effect(
    'refuses to remove the profile of a session that has not ended, and removes it once the session has',
    () =>
      Effect.gen(function* removesAfterEnd() {
        const profiles = yield* loadedProfiles
        yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
        const session = yield* startSession({ profileId: 'fake/work' })
        assert.strictEqual(yield* codeOf(profiles.remove('fake/work')), 'in_use')
        yield* (yield* SessionManager).stop(session.id)
        yield* profiles.remove('fake/work')
        assert.deepStrictEqual(yield* profiles.list(), [])
        assert.isNull((yield* sessionOf(session.id)).profileId)
      }),
  )
})
