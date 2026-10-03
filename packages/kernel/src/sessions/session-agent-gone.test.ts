import { assert, it } from '@effect/vitest'
import { Effect, Exit, Layer, Scope } from 'effect'
import { answerPending, questionRequest } from './session-ask-fixtures.js'
import { payloadsOf, sessionOf, startSession, waitFor } from './session-fixtures.js'
import { untilTrue } from './session-helpers.js'
import { prompted } from './session-prompted-fixtures.js'
import { driven } from './session-script-fixtures.js'

const FINISH = {
  type: 'turn.completed',
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const

const plain = driven()

it.layer(plain.layer)('SessionManager agent that goes away', (suite) => {
  suite.effect('crashes a session whose agent closes its event stream during a turn', () =>
    Effect.gen(function* crashesOnClose() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(plain, session)
      agent.queue.end()
      yield* waitFor(session.id, 'session.errored')
      assert.deepStrictEqual(yield* payloadsOf(session.id, 'session.errored'), [
        {
          status: 'errored',
          kind: 'crash',
          message: 'the agent closed its event stream',
          retryable: true,
        },
      ])
      assert.ok(agent.closed)
    }),
  )

  suite.effect(
    'lets go of an agent that goes away between two turns and starts another for the next prompt',
    () =>
      Effect.gen(function* attachesAgain() {
        const session = yield* startSession({ providerId: 'scripted' })
        const first = yield* prompted(plain, session)
        first.agent.queue.push(FINISH)
        yield* waitFor(session.id, 'session.ready', 1)
        first.agent.queue.end()
        yield* untilTrue(() => first.agent.closed)
        const second = yield* prompted(plain, session, { text: 'again' })
        assert.notStrictEqual(second.agent, first.agent)
        assert.strictEqual((yield* sessionOf(session.id)).status, 'running')
      }),
  )
})

const deaf = driven({
  onAnswer: async () => {
    await Promise.resolve()
    throw new Error('no ears')
  },
})

it.layer(deaf.layer)('SessionManager agent that does not take the answer', (suite) => {
  suite.effect('crashes the session once an answer cannot be passed on', () =>
    Effect.gen(function* crashesOnAnswer() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(deaf, session)
      agent.queue.push(questionRequest)
      yield* answerPending(session.id, ['a'])
      yield* waitFor(session.id, 'session.errored')
      assert.deepStrictEqual(yield* payloadsOf(session.id, 'session.errored'), [
        {
          status: 'errored',
          kind: 'protocol',
          message: 'the agent did not take the answer: no ears',
          retryable: false,
        },
      ])
    }),
  )
})

it.effect('lets every provider session go when the layer is released', () =>
  Effect.gen(function* releasesLayer() {
    const world = driven()
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(world.layer, scope)
    const session = yield* Effect.provide(startSession({ providerId: 'scripted' }), context)
    const { agent } = yield* Effect.provide(prompted(world, session), context)
    assert.ok(!agent.closed)
    yield* Scope.close(scope, Exit.void)
    assert.ok(agent.closed)
  }),
)
