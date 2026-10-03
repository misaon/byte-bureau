import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { AskService } from '../asks/ask-service.js'
import {
  answerPending,
  askToWrite,
  pendingAsk,
  questionRequest,
  writeRequest,
} from './session-ask-fixtures.js'
import { sessionOf, startSession, typesOf, waitFor } from './session-fixtures.js'
import { prompted } from './session-prompted-fixtures.js'
import { untilTrue } from './session-helpers.js'
import { push } from './session-push-fixtures.js'
import { driven } from './session-script-fixtures.js'

const plain = driven()

it.layer(plain.layer)('SessionManager asks of the agent', (suite) => {
  suite.effect('judges a permission by the real workspace of the session', () =>
    Effect.gen(function* judgesPermission() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(plain, session)
      const pending = yield* askToWrite(session, agent)
      const options = pending.questions.flatMap((question) => question.options)
      assert.strictEqual(pending.recommendationSource, 'policy')
      assert.deepStrictEqual(
        options.map((option) => [option.id, option.recommended]),
        [
          ['allow', true],
          ['deny', false],
        ],
      )
    }),
  )

  suite.effect('passes the answer on under the id the agent asked with', () =>
    Effect.gen(function* passesAnswerOn() {
      const asks = yield* AskService
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(plain, session)
      const pending = yield* askToWrite(session, agent)
      yield* asks.answer(pending.id, { selected: ['allow'] }, 'cli')
      yield* waitFor(session.id, 'session.running', 1)
      assert.deepStrictEqual(agent.answers, [
        { askId: 'provider-ask-1', answer: { selected: ['allow'] } },
      ])
    }),
  )

  suite.effect('announces the request, the wait, the answer and the run in that order', () =>
    Effect.gen(function* announcesInOrder() {
      const asks = yield* AskService
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(plain, session)
      const pending = yield* askToWrite(session, agent)
      yield* asks.answer(pending.id, { selected: ['deny'] }, 'cli')
      yield* waitFor(session.id, 'session.running', 1)
      const types = yield* typesOf(session.id)
      assert.deepStrictEqual(types.slice(-4), [
        'ask.requested',
        'session.waiting',
        'ask.answered',
        'session.running',
      ])
    }),
  )
})

const FINISH = {
  type: 'turn.completed',
  stopReason: 'end_turn',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const

it.layer(plain.layer)('SessionManager asks between two turns', (suite) => {
  suite.effect(
    'asks, answers and passes the answer on without changing the status of the session',
    () =>
      Effect.gen(function* asksBetweenTurns() {
        const session = yield* startSession({ providerId: 'scripted' })
        const { agent } = yield* prompted(plain, session)
        yield* push(session.id, agent, FINISH)
        agent.queue.push(writeRequest(session))
        yield* answerPending(session.id, ['allow'], 'ask.requested')
        yield* untilTrue(() => agent.answers.length === 1)
        assert.strictEqual((yield* sessionOf(session.id)).status, 'ready')
        assert.ok(!(yield* typesOf(session.id)).includes('session.waiting'))
      }),
  )
})

const BOT = {
  version: 1,
  project: { name: 'bot-test' },
  employees: {
    bot: {
      name: 'Bot',
      provider: 'scripted',
      model: 'm',
      permissionMode: 'autonomous',
      askTimeout: '5m',
    },
  },
}

it.layer(plain.layer)('SessionManager asks of an autonomous employee', (suite) => {
  suite.effect('answers a recommended question once the timeout of the employee has passed', () =>
    Effect.gen(function* answersOnTimeout() {
      const session = yield* startSession({ employeeId: 'bot', providerId: 'scripted' }, BOT)
      const { agent } = yield* prompted(plain, session)
      agent.queue.push(questionRequest)
      const pending = yield* pendingAsk(session.id)
      assert.deepStrictEqual(pending.policy, { onTimeout: 'recommended', timeout: '5m' })
      yield* TestClock.adjust('5 minutes')
      yield* untilTrue(() => agent.answers.length === 1)
      assert.deepStrictEqual(agent.answers, [{ askId: 'agent-ask', answer: { selected: ['a'] } }])
    }),
  )
})
