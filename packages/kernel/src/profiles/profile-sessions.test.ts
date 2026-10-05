import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { sessionOf, startSession } from '../sessions/session-fixtures.js'
import { sessionLayer } from '../sessions/session-layer-fixtures.js'
import { SessionManager } from '../sessions/session-manager.js'
import { codeOf, loadedProfiles } from './profile-fixtures.js'

const IN_USE =
  'profile "fake/work" is in use: 1 session(s) still run under it or can resume; complete them first'

// The repository of the session goes with the test, so the whole life of the session is one test
const heldUntilCompleted = Effect.gen(function* heldUntilCompleted() {
  const profiles = yield* loadedProfiles
  const sessions = yield* SessionManager
  yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  const session = yield* startSession({ profileId: 'fake/work' })
  const ready = yield* Effect.flip(profiles.remove('fake/work'))
  const stopped = yield* Effect.andThen(
    sessions.stop(session.id),
    codeOf(profiles.remove('fake/work')),
  )
  yield* Effect.andThen(sessions.resume(session.id), sessions.complete(session.id))
  yield* profiles.remove('fake/work')
  assert.deepStrictEqual(
    [ready.message, stopped, yield* profiles.list(), (yield* sessionOf(session.id)).profileId],
    [IN_USE, 'in_use', [], null],
  )
})

it.layer(sessionLayer())('ProfileService and the sessions that run under a profile', (suite) => {
  suite.effect(
    'holds a profile while its session runs or is stopped and can resume, and lets it go once the session is completed',
    () => heldUntilCompleted,
  )
})
