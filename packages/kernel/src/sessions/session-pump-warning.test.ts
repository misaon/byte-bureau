import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { warnings } from '../plugins/log-fixtures.js'
import { startSession } from './session-fixtures.js'
import { CALL_LIMIT, PUMP_LIMIT } from './session-live.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import { driven } from './session-script-fixtures.js'

// An agent whose events do not end when it is closed, so its pump is given up on
const stubborn = driven({ generator: true, hangs: ['close'] })

// Stops the session of a stuck agent and lets the time pass that the kernel waits for its closing and its pump
const stopStuck = Effect.gen(function* stopsStuck() {
  const session = yield* startSession({ providerId: 'scripted' })
  const { agent } = yield* prompted(stubborn, session)
  yield* agent.queue.reading.await
  const stopping = yield* Effect.forkChild((yield* SessionManager).stop(session.id), {
    startImmediately: true,
  })
  yield* agent.calls.close.await
  yield* TestClock.adjust(CALL_LIMIT)
  yield* TestClock.adjust(PUMP_LIMIT)
  yield* Fiber.join(stopping)
  agent.queue.end()
  return session.id
})

it.layer(stubborn.layer)('SessionManager pump that is given up on', (suite) => {
  suite.effect('tells that it gave up on the pump of the session it stopped', () =>
    Effect.gen(function* warnsAboutPump() {
      const records = yield* warnings
      const sessionId = yield* stopStuck
      const given = records.filter(
        (record) => record.message[0] === 'gave up waiting for the event pump of a session',
      )
      assert.deepStrictEqual(
        given.map((record) => record.properties['sessionId']),
        [sessionId],
      )
    }),
  )
})
