import type { AskQuestion } from '@bytebureau/protocol'
import type { LogRecord } from '@logtape/logtape'
import { assert, it } from '@effect/vitest'
import { Context, Effect, Exit, Layer, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { vi } from 'vitest'
import { warnings } from '../plugins/log-fixtures.js'
import { question, request } from './ask-fixtures.js'
import { AskService } from './ask-service.js'
import { dropAsks, flush, seedSession, TestLayer } from './ask-service-fixtures.js'

const TIMEOUT = '30 minutes'

const autonomous = { permissionMode: 'autonomous' } as const

const unrecommended: AskQuestion = {
  ...question,
  options: [{ id: 'a', label: 'A', recommended: false, evidence: [] }],
}

const shown = (records: readonly LogRecord[]): readonly unknown[] =>
  records.map((record) => [
    record.category.join('.'),
    record.level,
    record.message[0],
    record.properties['askId'],
  ])

// The warnings fixture keeps console.warn quiet; an error record would reach console.error
const quietErrors: Effect.Effect<void, never, Scope.Scope> = Effect.acquireRelease(
  Effect.sync(() => vi.spyOn(globalThis.console, 'error').mockReturnValue()),
  (spy) =>
    Effect.sync(() => {
      spy.mockRestore()
    }),
).pipe(Effect.asVoid)

// Everything the asks log, errors included
const logged: Effect.Effect<readonly LogRecord[], never, Scope.Scope> = Effect.andThen(
  quietErrors,
  warnings,
)

it.layer(TestLayer)('AskService logging', (suite) => {
  suite.effect('warns once when a question comes without a recommended option', () =>
    Effect.gen(function* warnsWithoutRecommendation() {
      const records = yield* warnings
      yield* seedSession('log-1')
      const asks = yield* AskService
      const ask = yield* asks.open(request('log-1', { questions: [unrecommended] }))
      assert.strictEqual(ask.recommendationSource, 'none')
      assert.deepStrictEqual(
        records.map((record) => [record.category.join('.'), record.level, record.properties]),
        [['bb.asks', 'warning', { sessionId: 'log-1', title: 'Choose' }]],
      )
    }),
  )

  suite.effect('warns when no rule recommends anything for a tool call', () =>
    Effect.gen(function* warnsWithoutRule() {
      const records = yield* warnings
      yield* seedSession('log-2')
      const asks = yield* AskService
      const toolCall = { name: 'Mystery', input: {} }
      yield* asks.open(request('log-2', { kind: 'permission', questions: [], toolCall }))
      assert.deepStrictEqual(
        records.map((record) => record.message),
        [['no recommendation available']],
      )
    }),
  )

  suite.effect('stays quiet when an option is recommended', () =>
    Effect.gen(function* staysQuiet() {
      const records = yield* warnings
      yield* seedSession('log-3')
      const asks = yield* AskService
      yield* asks.open(request('log-3'))
      assert.deepStrictEqual(records, [])
    }),
  )
})

it.layer(TestLayer)('AskService failing timer', (suite) => {
  suite.effect('logs an expiry the store could not record', () =>
    Effect.gen(function* logsFailedExpiry() {
      const records = yield* logged
      yield* seedSession('log-4')
      const asks = yield* AskService
      const ask = yield* asks.open(request('log-4', autonomous))
      yield* dropAsks
      yield* TestClock.adjust(TIMEOUT)
      yield* flush
      const failure = ['bb.asks', 'error', 'an ask could not be expired', ask.id]
      assert.deepStrictEqual(shown(records), [failure])
    }),
  )
})

it.effect('leaves no timer running once its layer is released', () =>
  Effect.gen(function* stopsTimers() {
    const records = yield* logged
    const scope = yield* Effect.acquireRelease(Scope.make(), (own) => Scope.close(own, Exit.void))
    const context = yield* Layer.buildWithScope(TestLayer, scope)
    const asks = Context.get(context, AskService)
    const opening = Effect.andThen(seedSession('stop-1'), asks.open(request('stop-1', autonomous)))
    yield* Effect.provide(opening, context)
    yield* Scope.close(scope, Exit.void)
    yield* TestClock.adjust(TIMEOUT)
    yield* flush
    assert.deepStrictEqual(records, [])
  }),
)
