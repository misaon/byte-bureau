import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { askOf, asking, option, question, request } from './ask-fixtures.js'
import { AskService } from './ask-service.js'
import { eventsOf, flush, seedSession, TestLayer } from './ask-service-fixtures.js'

const autonomous = { permissionMode: 'autonomous' } as const

const recommended = asking('q2', [option('x', false), option('y', true)])
const unmarked = asking('q2', [option('x', false), option('y', false)])
const twice = asking('q3', [option('a', true), option('b', true)])

it.layer(TestLayer)('AskService without a full recommendation', (suite) => {
  suite.effect('waits for a human when only one of two questions is recommended', () =>
    Effect.gen(function* waitsForPartialRecommendation() {
      yield* seedSession('rec-1')
      const asks = yield* AskService
      const ask = yield* asks.open(
        request('rec-1', { ...autonomous, questions: [question, unmarked] }),
      )
      assert.deepStrictEqual(
        [ask.recommendationSource, ask.policy.onTimeout, ask.deadlineAt],
        ['none', 'wait', null],
      )
      yield* TestClock.adjust('10 hours')
      yield* flush
      assert.strictEqual((yield* asks.pending('rec-1')).length, 1)
    }),
  )

  suite.effect('waits for a human when no option is recommended', () =>
    Effect.gen(function* waitsWithoutRecommendation() {
      yield* seedSession('rec-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('rec-2', { ...autonomous, questions: [unmarked] }))
      assert.deepStrictEqual([ask.recommendationSource, ask.policy.onTimeout], ['none', 'wait'])
      yield* TestClock.adjust('10 hours')
      yield* flush
      assert.deepStrictEqual(yield* eventsOf('rec-2'), [
        { type: 'ask.requested', payload: { ask: askOf(ask) } },
      ])
    }),
  )

  suite.effect('waits for a human when a question has two recommended options', () =>
    Effect.gen(function* waitsForDoubledRecommendation() {
      yield* seedSession('rec-3')
      const asks = yield* AskService
      const ask = yield* asks.open(request('rec-3', { permissionMode: 'yolo', questions: [twice] }))
      assert.deepStrictEqual([ask.recommendationSource, ask.policy.onTimeout], ['none', 'wait'])
      yield* TestClock.adjust('10 hours')
      yield* flush
      assert.strictEqual((yield* asks.pending('rec-3')).length, 1)
    }),
  )
})

it.layer(TestLayer)('AskService with a full recommendation', (suite) => {
  suite.effect('answers every question with its recommended option once the timeout is over', () =>
    Effect.gen(function* answersEveryQuestion() {
      yield* seedSession('rec-4')
      const asks = yield* AskService
      const ask = yield* asks.open(
        request('rec-4', { ...autonomous, questions: [question, recommended] }),
      )
      yield* TestClock.adjust('30 minutes')
      assert.deepStrictEqual(yield* asks.await(ask.id), { selected: ['a', 'y'] })
      const answered = { askId: ask.id, answer: { selected: ['a', 'y'] }, answeredVia: 'timeout' }
      assert.deepStrictEqual(yield* eventsOf('rec-4'), [
        { type: 'ask.requested', payload: { ask: askOf(ask) } },
        { type: 'ask.expired', payload: { askId: ask.id, fallback: 'recommended' } },
        { type: 'ask.answered', payload: answered },
      ])
    }),
  )
})
