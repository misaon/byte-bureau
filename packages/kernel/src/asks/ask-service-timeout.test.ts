import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { askOf, request } from './ask-fixtures.js'
import { AskService, DENY_ON_TIMEOUT_MESSAGE } from './ask-service.js'
import {
  atSystemTime,
  eventsOf,
  flush,
  rowOf,
  seedSession,
  seedTurn,
  TestLayer,
} from './ask-service-fixtures.js'

const autonomous = { permissionMode: 'autonomous' } as const

const TIMEOUT = '30 minutes'

const denial = { selected: ['deny'], otherText: DENY_ON_TIMEOUT_MESSAGE }

// A permission ask for a tool call the rules know, of an employee that works on its own
const permission = (sessionId: string): ReturnType<typeof request> =>
  request(sessionId, {
    ...autonomous,
    kind: 'permission',
    questions: [],
    toolCall: { name: 'Bash', input: { command: 'git status' } },
    askTimeout: '5m',
  })

it.layer(TestLayer)('AskService question timeout', (suite) => {
  suite.effect('proceeds with the recommended option once the timeout has passed', () =>
    Effect.gen(function* proceedsWithRecommended() {
      yield* seedSession('timeout-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timeout-1', autonomous))
      assert.strictEqual(ask.policy.onTimeout, 'recommended')
      const waiting = yield* Effect.forkChild(asks.await(ask.id))
      yield* TestClock.adjust(TIMEOUT)
      assert.deepStrictEqual(yield* Fiber.join(waiting), { selected: ['a'] })
      assert.strictEqual((yield* rowOf(ask.id)).answered_via, 'timeout')
    }),
  )

  suite.effect('announces the expiry with its fallback before the answer it produced', () =>
    Effect.gen(function* announcesExpiry() {
      yield* seedSession('timeout-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timeout-2', autonomous))
      yield* TestClock.adjust(TIMEOUT)
      yield* asks.await(ask.id)
      const answered = { askId: ask.id, answer: { selected: ['a'] }, answeredVia: 'timeout' }
      assert.deepStrictEqual(yield* eventsOf('timeout-2'), [
        { type: 'ask.requested', payload: { ask: askOf(ask) } },
        { type: 'ask.expired', payload: { askId: ask.id, fallback: 'recommended' } },
        { type: 'ask.answered', payload: answered },
      ])
    }),
  )
})

it.layer(TestLayer)('AskService deadline', (suite) => {
  suite.effect('sets the deadline one timeout after the ask was created', () =>
    Effect.gen(function* setsDeadline() {
      yield* seedSession('timeout-3')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timeout-3', { ...autonomous, askTimeout: '90s' }))
      const expected = new Date(Date.parse(ask.createdAt) + 90_000).toISOString()
      assert.strictEqual(ask.deadlineAt, expected)
      assert.strictEqual((yield* rowOf(ask.id)).deadline_at, expected)
    }),
  )

  suite.effect('expires every ask at its own deadline', () =>
    Effect.gen(function* expiresInTurn() {
      yield* seedSession('timeout-4')
      const asks = yield* AskService
      const soon = yield* asks.open(request('timeout-4', { ...autonomous, askTimeout: '5m' }))
      const late = yield* asks.open(request('timeout-4', { ...autonomous, askTimeout: '30m' }))
      yield* TestClock.adjust('5 minutes')
      yield* asks.await(soon.id)
      assert.strictEqual((yield* rowOf(late.id)).status, 'pending')
      yield* TestClock.adjust('25 minutes')
      assert.deepStrictEqual(yield* asks.await(late.id), { selected: ['a'] })
    }),
  )

  suite.effect('stamps the answer with the time of the timeout, not of the opening', () =>
    Effect.gen(function* stampsTimeout() {
      yield* seedSession('timeout-5')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timeout-5', autonomous))
      const later = Date.parse(ask.createdAt) + 1_800_000
      const expiry = Effect.andThen(TestClock.adjust(TIMEOUT), asks.await(ask.id))
      yield* atSystemTime(later, expiry)
      assert.strictEqual((yield* rowOf(ask.id)).answered_at, new Date(later).toISOString())
    }),
  )
})

it.layer(TestLayer)('AskService permission timeout', (suite) => {
  suite.effect('denies an autonomous permission ask with the documented message', () =>
    Effect.gen(function* deniesOnTimeout() {
      yield* seedSession('timeout-6')
      yield* seedTurn('timeout-6', 'turn-1')
      const asks = yield* AskService
      const ask = yield* asks.open({ ...permission('timeout-6'), turnId: 'turn-1' })
      assert.deepStrictEqual([ask.recommendationSource, ask.policy.onTimeout], ['policy', 'deny'])
      const waiting = yield* Effect.forkChild(asks.await(ask.id))
      yield* TestClock.adjust('5 minutes')
      assert.deepStrictEqual(yield* Fiber.join(waiting), denial)
    }),
  )

  suite.effect('offers allow and deny with the recommendation of the rules', () =>
    Effect.gen(function* offersTwoOptions() {
      yield* seedSession('timeout-7')
      const asks = yield* AskService
      const ask = yield* asks.open(permission('timeout-7'))
      const options = ask.questions.flatMap((entry) => entry.options)
      assert.deepStrictEqual(
        options.map((option) => [option.id, option.recommended]),
        [
          ['allow', true],
          ['deny', false],
        ],
      )
    }),
  )

  suite.effect('denies a permission ask that has no tool call just the same', () =>
    Effect.gen(function* deniesWithoutToolCall() {
      yield* seedSession('timeout-8')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timeout-8', { ...autonomous, kind: 'permission' }))
      yield* TestClock.adjust(TIMEOUT)
      assert.deepStrictEqual(yield* asks.await(ask.id), denial)
    }),
  )
})

it.layer(TestLayer)('AskService supervised timeout', (suite) => {
  suite.effect('waits indefinitely, a permission ask without a recommendation included', () =>
    Effect.gen(function* waitsIndefinitely() {
      yield* seedSession('timeout-9')
      const asks = yield* AskService
      const toolCall = { name: 'Mystery', input: {} }
      const ask = yield* asks.open(
        request('timeout-9', { kind: 'permission', questions: [], toolCall, askTimeout: '1m' }),
      )
      assert.strictEqual(ask.recommendationSource, 'none')
      yield* TestClock.adjust('10 hours')
      yield* flush
      assert.strictEqual((yield* asks.pending('timeout-9')).length, 1)
    }),
  )
})

it.layer(TestLayer)('AskService timer', (suite) => {
  suite.effect('leaves an ask a human answered in time alone', () =>
    Effect.gen(function* keepsHumanAnswer() {
      yield* seedSession('timer-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('timer-1', autonomous))
      yield* asks.answer(ask.id, { selected: ['b'] }, 'cli')
      yield* TestClock.adjust(TIMEOUT)
      yield* flush
      const answered = { askId: ask.id, answer: { selected: ['b'] }, answeredVia: 'cli' }
      assert.deepStrictEqual(yield* eventsOf('timer-1'), [
        { type: 'ask.requested', payload: { ask: askOf(ask) } },
        { type: 'ask.answered', payload: answered },
      ])
    }),
  )

  suite.effect('outlives the fiber that opened the ask', () =>
    Effect.gen(function* outlivesOpener() {
      yield* seedSession('timer-2')
      const asks = yield* AskService
      const opening = yield* Effect.forkChild(asks.open(request('timer-2', autonomous)))
      const ask = yield* Fiber.join(opening)
      yield* TestClock.adjust(TIMEOUT)
      assert.deepStrictEqual(yield* asks.await(ask.id), { selected: ['a'] })
    }),
  )
})
