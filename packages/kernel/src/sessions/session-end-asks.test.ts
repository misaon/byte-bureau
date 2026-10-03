import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { AskService } from '../asks/ask-service.js'
import { questionRequest } from './session-ask-fixtures.js'
import { sessionOf, startSession, typesOf, waitFor } from './session-fixtures.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import { FINISH, push } from './session-push-fixtures.js'
import { driven } from './session-script-fixtures.js'

const AGENT = { providerId: 'scripted' } as const
const WAITING = 'session.waiting'

const world = driven()

// A tool call that starts and ends, under an id of its own
const CALL = [
  { type: 'tool.started', id: 'late', name: 'Bash', kind: 'bash', input: null },
  { type: 'tool.completed', id: 'late', outputSummary: 'ok', bytes: 2 },
] as const

it.layer(world.layer)('SessionManager stop while the agent waits for a human', (suite) => {
  suite.effect('drops the events the agent had queued behind its question', () =>
    Effect.gen(function* dropsQueuedEvents() {
      const sessions = yield* SessionManager
      const session = yield* startSession(AGENT)
      const { agent } = yield* prompted(world, session)
      agent.queue.push(questionRequest, ...CALL, FINISH)
      yield* waitFor(session.id, WAITING)
      yield* sessions.stop(session.id)
      const types = yield* typesOf(session.id)
      assert.deepStrictEqual(types.slice(-4), [
        WAITING,
        'turn.interrupted',
        'ask.cancelled',
        'session.stopped',
      ])
      assert.deepStrictEqual(
        types.filter((type) => type === 'tool.started' || type === 'turn.completed'),
        [],
      )
    }),
  )

  suite.effect('leaves the session stopped and the question cancelled', () =>
    Effect.gen(function* leavesSessionStopped() {
      const sessions = yield* SessionManager
      const asks = yield* AskService
      const session = yield* startSession(AGENT)
      const { agent } = yield* prompted(world, session)
      agent.queue.push(questionRequest, FINISH)
      yield* waitFor(session.id, WAITING)
      yield* sessions.stop(session.id)
      assert.strictEqual((yield* sessionOf(session.id)).status, 'stopped')
      assert.deepStrictEqual(yield* asks.pending(session.id), [])
    }),
  )
})

it.layer(world.layer)('SessionManager complete with a question open', (suite) => {
  suite.effect('cancels the question an agent asked between two turns', () =>
    Effect.gen(function* cancelsQuestionAtComplete() {
      const sessions = yield* SessionManager
      const asks = yield* AskService
      const session = yield* startSession(AGENT)
      const { agent } = yield* prompted(world, session)
      yield* push(session.id, agent, FINISH)
      agent.queue.push(questionRequest)
      yield* waitFor(session.id, 'ask.requested')
      yield* sessions.complete(session.id)
      assert.deepStrictEqual(yield* asks.pending(session.id), [])
      assert.deepStrictEqual((yield* typesOf(session.id)).slice(-2), [
        'ask.cancelled',
        'session.completed',
      ])
    }),
  )
})

const INTERRUPTED = {
  type: 'turn.completed',
  stopReason: 'interrupted',
  usage: { inputTokens: 0, outputTokens: 0 },
} as const

it.layer(world.layer)('SessionManager question after an interrupt', (suite) => {
  suite.effect(
    'cancels the question of the turn that was interrupted and does not wait for it',
    () =>
      Effect.gen(function* cancelsStaleQuestion() {
        const sessions = yield* SessionManager
        const asks = yield* AskService
        const session = yield* startSession(AGENT)
        const { agent } = yield* prompted(world, session)
        yield* sessions.interrupt(session.id)
        agent.queue.push(questionRequest, INTERRUPTED)
        yield* waitFor(session.id, 'session.ready', 1)
        assert.deepStrictEqual(yield* asks.pending(session.id), [])
        const types = yield* typesOf(session.id)
        assert.deepStrictEqual(
          types.filter((type) => type.startsWith('ask.') || type === WAITING),
          ['ask.requested', 'ask.cancelled'],
        )
      }),
  )

  suite.effect('still asks for a turn that began after the interrupt', () =>
    Effect.gen(function* asksAgain() {
      const sessions = yield* SessionManager
      const session = yield* startSession(AGENT)
      const first = yield* prompted(world, session)
      yield* sessions.interrupt(session.id)
      yield* push(session.id, first.agent, INTERRUPTED)
      yield* prompted(world, session, { text: 'again' })
      first.agent.queue.push(questionRequest)
      yield* waitFor(session.id, WAITING)
      assert.strictEqual((yield* sessionOf(session.id)).status, 'waiting_for_human')
    }),
  )
})
