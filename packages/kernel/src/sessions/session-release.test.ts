import { assert, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Layer, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import type { ScriptedSession } from '../testing/scripted-provider.js'
import { sessionOf, startSession } from './session-fixtures.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import { FINISH, push } from './session-push-fixtures.js'
import { driven, type Driven } from './session-script-fixtures.js'

const AGENT = { providerId: 'scripted' } as const
const CALL_LIMIT = '10 seconds'
const PUMP_LIMIT = '3 seconds'

// The time the kernel waits for the agent to close, and then for the pump of its events to end
const givesUp = (agent: ScriptedSession): Effect.Effect<void> =>
  Effect.gen(function* givesUpOnAgent() {
    yield* agent.calls.close.await
    yield* TestClock.adjust(CALL_LIMIT)
    yield* TestClock.adjust(PUMP_LIMIT)
  })

// A prompted session on a layer of its own, whose agent waits for its next event, and the release of that layer
interface Running {
  readonly agent: ScriptedSession
  readonly release: Effect.Effect<void>
}

const startRunning = (world: Driven): Effect.Effect<Running, unknown> =>
  Effect.gen(function* startsRunning() {
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(world.layer, scope)
    const session = yield* Effect.provide(startSession(AGENT), context)
    const { agent } = yield* Effect.provide(prompted(world, session), context)
    yield* agent.queue.reading.await
    return { agent, release: Scope.close(scope, Exit.void) }
  })

// The events of an agent that is a generator, as they usually are, wait for the read in progress before they return
it.effect(
  'lets every provider session go when the layer is released, whatever shape its events have',
  () =>
    Effect.gen(function* releasesLayer() {
      const { agent, release } = yield* startRunning(driven({ generator: true }))
      yield* release
      assert.ok(agent.closed)
    }),
)

// The events of an agent that does not end them are ended by the test, so no pump is left behind
it.effect('gives up on a pump that does not end when the layer is released', () =>
  Effect.gen(function* givesUpAtRelease() {
    const { agent, release } = yield* startRunning(driven({ generator: true, hangs: ['close'] }))
    const releasing = yield* Effect.forkChild(release, { startImmediately: true })
    yield* givesUp(agent)
    yield* Fiber.join(releasing)
    agent.queue.end()
    assert.ok(agent.closed)
  }),
)

const generating = driven({ generator: true })

it.layer(generating.layer)('SessionManager agent whose events are a generator', (suite) => {
  suite.effect('stops a session at once', () =>
    Effect.gen(function* stopsAtOnce() {
      const sessions = yield* SessionManager
      const session = yield* startSession(AGENT)
      const { agent } = yield* prompted(generating, session)
      yield* push(session.id, agent)
      yield* sessions.stop(session.id)
      assert.strictEqual((yield* sessionOf(session.id)).status, 'stopped')
    }),
  )

  suite.effect('completes a session at once', () =>
    Effect.gen(function* completesAtOnce() {
      const sessions = yield* SessionManager
      const session = yield* startSession(AGENT)
      const { agent } = yield* prompted(generating, session)
      yield* push(session.id, agent, FINISH)
      yield* sessions.complete(session.id)
      assert.strictEqual((yield* sessionOf(session.id)).status, 'completed')
    }),
  )
})

const stubborn = driven({ generator: true, hangs: ['close'] })

it.layer(stubborn.layer)(
  'SessionManager agent whose events do not end when it is closed',
  (suite) => {
    suite.effect('gives up on its pump after a while and stops the session', () =>
      Effect.gen(function* givesUpOnPumpAtStop() {
        const sessions = yield* SessionManager
        const session = yield* startSession(AGENT)
        const { agent } = yield* prompted(stubborn, session)
        yield* agent.queue.reading.await
        const stopping = yield* Effect.forkChild(sessions.stop(session.id), {
          startImmediately: true,
        })
        yield* givesUp(agent)
        yield* Fiber.join(stopping)
        agent.queue.end()
        assert.strictEqual((yield* sessionOf(session.id)).status, 'stopped')
      }),
    )

    suite.effect('gives up on its pump after a while and completes the session', () =>
      Effect.gen(function* givesUpOnPumpAtComplete() {
        const sessions = yield* SessionManager
        const session = yield* startSession(AGENT)
        const { agent } = yield* prompted(stubborn, session)
        yield* push(session.id, agent, FINISH)
        const completing = yield* Effect.forkChild(sessions.complete(session.id), {
          startImmediately: true,
        })
        yield* givesUp(agent)
        yield* Fiber.join(completing)
        agent.queue.end()
        assert.strictEqual((yield* sessionOf(session.id)).status, 'completed')
      }),
    )
  },
)
