import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { AskService } from '../asks/ask-service.js'
import { askToWrite } from './session-ask-fixtures.js'
import { payloadsOf, sessionOf, startSession, waitFor } from './session-fixtures.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import { driven } from './session-script-fixtures.js'
import type { Session } from './types.js'

const LIMIT = '10 seconds'

// One tick of the clock, then a look at the session
const tick = (sessionId: string): Effect.Effect<Session, unknown, SessionManager> =>
  Effect.andThen(TestClock.adjust(LIMIT), sessionOf(sessionId))

// Lets time pass, ten seconds at a time, until the session has the status
const adjustUntil = (
  sessionId: string,
  status: string,
): Effect.Effect<void, unknown, SessionManager> =>
  Effect.asVoid(Effect.repeat(tick(sessionId), { until: (session) => session.status === status }))

const mute = driven({ hangs: ['interrupt', 'close'] })

it.layer(mute.layer)('SessionManager agent that does not answer when it is stopped', (suite) => {
  suite.effect('gives up on its interruption and its closing, and stops the session', () =>
    Effect.gen(function* givesUp() {
      const sessions = yield* SessionManager
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(mute, session)
      const stopping = yield* Effect.forkChild(sessions.stop(session.id), {
        startImmediately: true,
      })
      yield* adjustUntil(session.id, 'stopped')
      yield* Fiber.join(stopping)
      assert.deepStrictEqual(
        [agent.interrupts, agent.closed, agent.request.signal.aborted],
        [1, true, true],
      )
    }),
  )
})

const deaf = driven({ hangs: ['answer'] })

it.layer(deaf.layer)('SessionManager agent that does not take an answer in time', (suite) => {
  suite.effect('crashes the session once the answer has not been taken within the limit', () =>
    Effect.gen(function* crashesOnSilence() {
      const asks = yield* AskService
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(deaf, session)
      const pending = yield* askToWrite(session, agent)
      yield* asks.answer(pending.id, { selected: ['allow'] }, 'cli')
      yield* waitFor(session.id, 'ask.answered')
      yield* adjustUntil(session.id, 'errored')
      const [crash] = yield* payloadsOf(session.id, 'session.errored')
      assert.match(JSON.stringify(crash), /the agent did not take the answer/u)
    }),
  )
})
