import type { CreateSessionRequest } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect, Fiber, type Cause } from 'effect'
import { ProviderError } from '../errors.js'
import type { ScriptedSession } from '../testing/scripted-provider.js'
import { sessionOf, startSession } from './session-fixtures.js'
import { firstOf } from './session-helper-fixtures.js'
import { SessionManager } from './session-manager.js'
import { promptWhileStartHangs } from './session-prompted-fixtures.js'
import { driven, type Driven } from './session-script-fixtures.js'

const AGENT = { providerId: 'scripted' } as const

// The start that was held finishes at last: the request it was made with, and the agent it ends with once the kernel has dealt with it
interface Late {
  readonly request: CreateSessionRequest
  readonly agent: ScriptedSession
}

const finishLate = (world: Driven): Effect.Effect<Late, Cause.NoSuchElementError> =>
  Effect.gen(function* finishesLate() {
    world.scripted.release()
    yield* world.scripted.created.await
    const request = yield* firstOf(world.scripted.requests)
    const agent = yield* firstOf(world.scripted.sessions)
    yield* agent.calls.close.await
    return { request, agent }
  })

const slow = driven({ holdsStart: true })

it.layer(slow.layer)('SessionManager agent that does not start in time', (suite) => {
  suite.effect('fails the prompt once the start has not finished within the limit', () =>
    Effect.gen(function* givesUpOnStart() {
      const session = yield* startSession(AGENT)
      const error = yield* promptWhileStartHangs(slow, session)
      assert.ok(error instanceof ProviderError)
      assert.match(error.reason, /timed out/iu)
      assert.strictEqual((yield* sessionOf(session.id)).status, 'ready')
    }),
  )
})

const aborting = driven({ holdsStart: true })

it.layer(aborting.layer)('SessionManager start that is given up on', (suite) => {
  suite.effect('aborts the signal of the start', () =>
    Effect.gen(function* abortsStart() {
      yield* promptWhileStartHangs(aborting, yield* startSession(AGENT))
      const request = yield* firstOf(aborting.scripted.requests)
      assert.ok(request.signal.aborted)
    }),
  )
})

const late = driven({ holdsStart: true })

it.layer(late.layer)('SessionManager start that finishes late', (suite) => {
  suite.effect('closes the agent that finishes starting after the kernel gave up', () =>
    Effect.gen(function* closesLateAgent() {
      yield* promptWhileStartHangs(late, yield* startSession(AGENT))
      const { agent } = yield* finishLate(late)
      assert.ok(agent.closed)
    }),
  )
})

const leaving = driven({ holdsStart: true })

it.layer(leaving.layer)('SessionManager start whose caller goes away', (suite) => {
  suite.effect('calls off the start and closes the agent that finishes it', () =>
    Effect.gen(function* callsOffStartOfCaller() {
      const sessions = yield* SessionManager
      const session = yield* startSession(AGENT)
      const prompting = yield* Effect.forkChild(sessions.prompt(session.id, { text: 'go' }), {
        startImmediately: true,
      })
      yield* leaving.scripted.asked.await
      yield* Fiber.interrupt(prompting)
      const { request, agent } = yield* finishLate(leaving)
      assert.deepStrictEqual([request.signal.aborted, agent.closed], [true, true])
    }),
  )
})
