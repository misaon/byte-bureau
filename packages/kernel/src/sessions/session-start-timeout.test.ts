import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { ProviderError } from '../errors.js'
import { sessionOf, startSession } from './session-fixtures.js'
import { SessionManager } from './session-manager.js'
import { driven } from './session-script-fixtures.js'

const sleeper = driven({ startHangs: true })

it.layer(sleeper.layer)('SessionManager agent that does not start in time', (suite) => {
  suite.effect('fails the prompt once the start has not finished within the limit', () =>
    Effect.gen(function* givesUpOnStart() {
      const sessions = yield* SessionManager
      const session = yield* startSession({ providerId: 'scripted' })
      const prompting = yield* Effect.forkChild(sessions.prompt(session.id, { text: 'go' }), {
        startImmediately: true,
      })
      yield* TestClock.adjust('60 seconds')
      const error = yield* Effect.flip(Fiber.join(prompting))
      assert.ok(error instanceof ProviderError)
      assert.match(error.reason, /timed out/iu)
      assert.strictEqual((yield* sessionOf(session.id)).status, 'ready')
    }),
  )
})
