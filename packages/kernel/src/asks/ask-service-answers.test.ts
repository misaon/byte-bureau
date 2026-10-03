import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { asking, option, request } from './ask-fixtures.js'
import { AskService } from './ask-service.js'
import {
  codeOf,
  eventsOf,
  reasonOf,
  rowOf,
  seedSession,
  TestLayer,
} from './ask-service-fixtures.js'

// A question that offers a and b and takes no words of the person's own
const closed = { ...asking('closed', [option('a', true), option('b', false)]), allowOther: false }

it.layer(TestLayer)('AskService answers that do not fit the ask', (suite) => {
  suite.effect('refuses an option the ask does not offer and leaves it pending', () =>
    Effect.gen(function* refusesUnknownOption() {
      yield* seedSession('answer-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('answer-1', { questions: [closed] }))
      const refused = yield* Effect.flip(asks.answer(ask.id, { selected: ['a', 'z'] }, 'cli'))
      assert.deepStrictEqual(
        [codeOf(refused), reasonOf(refused)],
        ['invalid_answer', `ask ${ask.id} has no option z`],
      )
      assert.strictEqual((yield* rowOf(ask.id)).status, 'pending')
      assert.deepStrictEqual(
        (yield* eventsOf('answer-1')).map((event) => event.type),
        ['ask.requested'],
      )
    }),
  )

  suite.effect('refuses words of the person own where no question takes them', () =>
    Effect.gen(function* refusesOther() {
      yield* seedSession('answer-2')
      const asks = yield* AskService
      const ask = yield* asks.open(request('answer-2', { questions: [closed] }))
      const refused = yield* Effect.flip(
        asks.answer(ask.id, { selected: 'other', otherText: 'mine' }, 'cli'),
      )
      assert.deepStrictEqual(
        [codeOf(refused), reasonOf(refused)],
        ['invalid_answer', `ask ${ask.id} takes no answer of its own`],
      )
    }),
  )
})

it.layer(TestLayer)('AskService answers that fit the ask', (suite) => {
  suite.effect(
    'takes an offered option, and words of the person own where a question allows them',
    () =>
      Effect.gen(function* takesValidAnswers() {
        yield* seedSession('answer-3')
        const asks = yield* AskService
        const first = yield* asks.open(request('answer-3', { questions: [closed] }))
        const second = yield* asks.open(request('answer-3'))
        const picked = yield* asks.answer(first.id, { selected: ['b'] }, 'cli')
        const written = yield* asks.answer(
          second.id,
          { selected: 'other', otherText: 'mine' },
          'api',
        )
        assert.deepStrictEqual([picked.status, written.status], ['answered', 'answered'])
      }),
  )
})
