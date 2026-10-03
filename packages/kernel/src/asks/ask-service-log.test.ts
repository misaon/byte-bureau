import type { LogRecord } from '@logtape/logtape'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { warnings } from '../plugins/log-fixtures.js'
import { asking, option, question, request } from './ask-fixtures.js'
import { logged } from './ask-log-fixtures.js'
import { AskService } from './ask-service.js'
import { dropAsks, flush, seedSession, TestLayer } from './ask-service-fixtures.js'

const TIMEOUT = '30 minutes'

const autonomous = { permissionMode: 'autonomous' } as const

const unrecommended = asking('q2', [option('a', false)])
const doubled = asking('q3', [option('a', true), option('b', true)])

const shown = (records: readonly LogRecord[]): readonly unknown[] =>
  records.map((record) => [
    record.category.join('.'),
    record.level,
    record.message[0],
    record.properties,
  ])

it.layer(TestLayer)('AskService logging', (suite) => {
  suite.effect('warns once with the kind and the unrecommended questions of a question', () =>
    Effect.gen(function* warnsWithoutRecommendation() {
      const records = yield* warnings
      yield* seedSession('log-1')
      const asks = yield* AskService
      const questions = [question, unrecommended, doubled]
      const ask = yield* asks.open(request('log-1', { questions }))
      assert.strictEqual(ask.recommendationSource, 'none')
      const properties = { sessionId: 'log-1', kind: 'question', questions: ['q2', 'q3'] }
      assert.deepStrictEqual(shown(records), [
        ['bb.asks', 'warning', 'no recommendation available', properties],
      ])
    }),
  )

  suite.effect('warns with the name of the tool when no rule recommends anything for it', () =>
    Effect.gen(function* warnsWithoutRule() {
      const records = yield* warnings
      yield* seedSession('log-2')
      const asks = yield* AskService
      const toolCall = { name: 'Mystery', input: {} }
      yield* asks.open(request('log-2', { kind: 'permission', questions: [], toolCall }))
      const properties = {
        sessionId: 'log-2',
        kind: 'permission',
        toolName: 'Mystery',
        questions: ['permission'],
      }
      assert.deepStrictEqual(shown(records), [
        ['bb.asks', 'warning', 'no recommendation available', properties],
      ])
    }),
  )
})

it.layer(TestLayer)('AskService logging of secrets and of silence', (suite) => {
  suite.effect('leaves the title and the input of the tool out of the log', () =>
    Effect.gen(function* keepsSecretsOut() {
      const records = yield* warnings
      yield* seedSession('log-3')
      const asks = yield* AskService
      const input = { command: 'curl -H "Authorization: sk-live-123"' }
      const title = 'Run curl -H "Authorization: sk-live-123"'
      const toolCall = { name: 'Mystery', input }
      yield* asks.open(request('log-3', { kind: 'permission', title, toolCall }))
      assert.strictEqual(records.length, 1)
      assert.strictEqual(JSON.stringify(records).includes('sk-live-123'), false)
    }),
  )

  suite.effect('stays quiet when every question is recommended', () =>
    Effect.gen(function* staysQuiet() {
      const records = yield* warnings
      yield* seedSession('log-4')
      const asks = yield* AskService
      yield* asks.open(request('log-4'))
      assert.deepStrictEqual(records, [])
    }),
  )
})

const failures = (records: readonly LogRecord[]): readonly unknown[] =>
  records.map((record) => [
    record.category.join('.'),
    record.level,
    record.message[0],
    record.properties['askId'],
  ])

it.layer(TestLayer)('AskService failing timer', (suite) => {
  suite.effect('logs an expiry the store could not record', () =>
    Effect.gen(function* logsFailedExpiry() {
      const records = yield* logged
      yield* seedSession('log-5')
      const asks = yield* AskService
      const ask = yield* asks.open(request('log-5', autonomous))
      yield* dropAsks
      yield* TestClock.adjust(TIMEOUT)
      yield* flush
      const failure = ['bb.asks', 'error', 'an ask could not be expired', ask.id]
      assert.deepStrictEqual(failures(records), [failure])
    }),
  )
})
