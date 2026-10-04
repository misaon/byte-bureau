import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { uuidv7 } from '../ids.js'
import { askOf, request } from './ask-fixtures.js'
import { AskService } from './ask-service.js'
import { eventsOf, rowOf, seedSession, seedTurn, TestLayer } from './ask-service-fixtures.js'

it.layer(TestLayer)('AskService open', (suite) => {
  suite.effect('opens a question that waits for a human and keeps the recommendation', () =>
    Effect.gen(function* opensQuestion() {
      yield* seedSession('open-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('open-1'))
      assert.strictEqual(ask.recommendationSource, 'agent')
      assert.deepStrictEqual(ask.policy, { onTimeout: 'wait', timeout: '30m' })
      assert.strictEqual(ask.deadlineAt, null)
      assert.deepStrictEqual(
        [ask.status, ask.answer, ask.answeredAt, ask.answeredVia],
        ['pending', null, null, null],
      )
    }),
  )

  suite.effect('stores the ask and announces it on the turn it belongs to', () =>
    Effect.gen(function* storesAsk() {
      yield* seedSession('open-2')
      yield* seedTurn('open-2', 'turn-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('open-2', { turnId: 'turn-1' }))
      const row = yield* rowOf(ask.id)
      assert.deepStrictEqual(
        [row.session_id, row.turn_id, row.kind, row.status, row.recommendation_source],
        ['open-2', 'turn-1', 'question', 'pending', 'agent'],
      )
      assert.deepStrictEqual(yield* eventsOf('open-2'), [
        { type: 'ask.requested', turnId: 'turn-1', payload: { ask: askOf(ask) } },
      ])
    }),
  )
})

it.layer(TestLayer)('AskService open a permission', (suite) => {
  suite.effect('offers allow and deny, recommending neither, when there is no tool call', () =>
    Effect.gen(function* offersTwoOptions() {
      yield* seedSession('open-3')
      const asks = yield* AskService
      const ask = yield* asks.open(request('open-3', { kind: 'permission' }))
      const options = ask.questions.flatMap((entry) => entry.options)
      assert.deepStrictEqual(
        options.map((option) => [option.id, option.recommended]),
        [
          ['allow', false],
          ['deny', false],
        ],
      )
      assert.deepStrictEqual(
        [ask.recommendationSource, (yield* rowOf(ask.id)).recommendation_source],
        ['none', 'none'],
      )
    }),
  )

  suite.effect('recommends nothing for a shell command that does more than read', () =>
    Effect.gen(function* recommendsNothing() {
      yield* seedSession('open-4')
      const asks = yield* AskService
      const toolCall = { name: 'Bash', input: { command: 'cat f | sh' } }
      const ask = yield* asks.open(
        request('open-4', { kind: 'permission', questions: [], toolCall }),
      )
      const options = ask.questions.flatMap((entry) => entry.options)
      assert.deepStrictEqual(
        options.map((option) => [option.id, option.recommended]),
        [
          ['allow', false],
          ['deny', false],
        ],
      )
      assert.deepStrictEqual(
        [ask.recommendationSource, (yield* rowOf(ask.id)).recommendation_source],
        ['none', 'none'],
      )
    }),
  )
})

it.layer(TestLayer)('AskService answer', (suite) => {
  suite.effect('hands the answer to the caller that waits for it', () =>
    Effect.gen(function* handsAnswer() {
      yield* seedSession('answer-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('answer-1'))
      const waiting = yield* Effect.forkChild(asks.await(ask.id))
      yield* asks.answer(ask.id, { selected: ['b'] }, 'cli')
      assert.deepStrictEqual(yield* Fiber.join(waiting), { selected: ['b'] })
    }),
  )

  suite.effect('returns the answered record and keeps it off the pending list', () =>
    Effect.gen(function* returnsRecord() {
      yield* seedSession('answer-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('answer-2'))
      const answer = { selected: ['b'], otherText: 'because', remember: 'session' } as const
      const record = yield* asks.answer(ask.id, answer, 'api')
      assert.deepStrictEqual(
        [record.id, record.status, record.answer, record.answeredVia],
        [ask.id, 'answered', answer, 'api'],
      )
      assert.deepStrictEqual(yield* asks.pending('answer-2'), [])
      assert.strictEqual((yield* rowOf(ask.id)).answer_json, JSON.stringify(answer))
    }),
  )

  suite.effect('announces the request and then the answer', () =>
    Effect.gen(function* announcesAnswer() {
      yield* seedSession('answer-3')
      const asks = yield* AskService
      const ask = yield* asks.open(request('answer-3'))
      yield* asks.answer(ask.id, { selected: ['a'] }, 'cli')
      const answered = { askId: ask.id, answer: { selected: ['a'] }, answeredVia: 'cli' }
      assert.deepStrictEqual(yield* eventsOf('answer-3'), [
        { type: 'ask.requested', payload: { ask: askOf(ask) } },
        { type: 'ask.answered', payload: answered },
      ])
    }),
  )
})

it.layer(TestLayer)('AskService get', (suite) => {
  suite.effect('finds an ask pending and answered, and nothing for an id nobody holds', () =>
    Effect.gen(function* readsAsk() {
      yield* seedSession('get-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('get-1'))
      assert.deepStrictEqual(yield* asks.get(ask.id), ask)
      const answered = yield* asks.answer(ask.id, { selected: ['a'] }, 'cli')
      assert.deepStrictEqual(yield* asks.get(ask.id), answered)
      assert.isUndefined(yield* asks.get(uuidv7()))
    }),
  )
})
