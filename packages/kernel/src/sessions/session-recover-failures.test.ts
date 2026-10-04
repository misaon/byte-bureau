import type { LogRecord } from '@logtape/logtape'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { warnings } from '../plugins/log-fixtures.js'
import { payloadsOf, registerRepo } from './session-fixtures.js'
import { sessionLayer } from './session-layer-fixtures.js'
import { SessionManager } from './session-manager.js'
import { leftBehind, seedBrokenAsk, seedUnreadable } from './session-recover-fixtures.js'

const UNREADABLE = 'a session left at work cannot be read and is not recovered'
const NOT_RECOVERED = 'a session left at work could not be recovered'

// The sessions the warnings with that message name
const named = (records: readonly LogRecord[], message: string): readonly unknown[] =>
  records
    .filter((record) => record.message[0] === message)
    .map((record) => record.properties['sessionId'])

it.layer(sessionLayer())('SessionManager.recover of what it cannot read or settle', (suite) => {
  suite.effect('passes over a record it cannot read, says so and recovers the others', () =>
    Effect.gen(function* passesOverUnreadable() {
      const records = yield* warnings
      const project = yield* registerRepo()
      const unreadable = yield* seedUnreadable(project.id)
      const { sessionId } = yield* leftBehind(project.id, 'running')
      const recovered = yield* SessionManager.use((sessions) => sessions.recover())
      assert.deepStrictEqual([recovered, named(records, UNREADABLE)], [[sessionId], [unreadable]])
    }),
  )

  suite.effect('passes over a session it cannot settle, says so and recovers the others', () =>
    Effect.gen(function* passesOverFailure() {
      const records = yield* warnings
      const project = yield* registerRepo()
      const waiting = yield* leftBehind(project.id, 'waiting_for_human')
      yield* seedBrokenAsk(waiting)
      const { sessionId } = yield* leftBehind(project.id, 'running')
      const recovered = yield* SessionManager.use((sessions) => sessions.recover())
      assert.deepStrictEqual(
        [recovered, named(records, NOT_RECOVERED)],
        [[sessionId], [waiting.sessionId]],
      )
    }),
  )
})

// The recovery of two starts of a daemon, one after the other
const twoStarts = SessionManager.use((sessions) =>
  Effect.andThen(sessions.recover(), sessions.recover()),
)

it.layer(sessionLayer())('SessionManager.recover across starts', (suite) => {
  suite.effect(
    'tells a session it cannot settle once, as a warning in the log and on the session',
    () =>
      Effect.gen(function* tellsOnce() {
        const records = yield* warnings
        const project = yield* registerRepo()
        const waiting = yield* leftBehind(project.id, 'waiting_for_human')
        yield* seedBrokenAsk(waiting)
        // Every start tries again; only the first says so
        yield* twoStarts
        const told = yield* payloadsOf(waiting.sessionId, 'session.warning')
        assert.deepStrictEqual(named(records, NOT_RECOVERED), [waiting.sessionId])
        assert.strictEqual(told.length, 1)
        assert.containSubset(told, [{ kind: 'recovery_failed' }])
      }),
  )

  suite.effect('tells a record it cannot read once, whatever the number of starts', () =>
    Effect.gen(function* tellsUnreadableOnce() {
      const records = yield* warnings
      const project = yield* registerRepo()
      const unreadable = yield* seedUnreadable(project.id)
      yield* twoStarts
      assert.deepStrictEqual(named(records, UNREADABLE), [unreadable])
    }),
  )
})
