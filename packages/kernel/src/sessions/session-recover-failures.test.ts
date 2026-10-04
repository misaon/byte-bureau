import type { LogRecord } from '@logtape/logtape'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { warnings } from '../plugins/log-fixtures.js'
import { registerRepo } from './session-fixtures.js'
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
