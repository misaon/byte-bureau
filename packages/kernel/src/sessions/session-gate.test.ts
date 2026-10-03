import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { sessionOf, startSession, typesOf } from './session-fixtures.js'
import { gatedUsage } from './session-gate-fixtures.js'
import { flush } from './session-helpers.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import { driven } from './session-script-fixtures.js'

const gate = gatedUsage()
const gated = driven({}, {}, gate.layer)

const LIMIT = { type: 'ratelimit.updated', rateLimit: { fiveHourPct: 80 } } as const

// A stop that is asked for while the agent's rate limit is being recorded; the recording waits at the gate
const stopWhileRecording = Effect.gen(function* stopsWhileRecording() {
  const sessions = yield* SessionManager
  const session = yield* startSession({ providerId: 'scripted' })
  const { agent } = yield* prompted(gated, session)
  agent.queue.push(LIMIT)
  yield* gate.entered.await
  const stopping = yield* Effect.forkChild(sessions.stop(session.id))
  yield* flush
  return { session, agent, stopping }
})

it.layer(gated.layer)('SessionManager command while an event is applied', (suite) => {
  suite.effect('makes a stop wait for the event that is being applied', () =>
    Effect.gen(function* waitsForEvent() {
      const { session, agent, stopping } = yield* stopWhileRecording
      const waiting = [(yield* sessionOf(session.id)).status, agent.closed]
      yield* gate.release.open
      yield* Fiber.join(stopping)
      const types = yield* typesOf(session.id)
      assert.deepStrictEqual(waiting, ['running', false])
      assert.deepStrictEqual(types.slice(-3), [
        'ratelimit.updated',
        'turn.interrupted',
        'session.stopped',
      ])
    }),
  )
})
