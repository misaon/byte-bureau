import { assert, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError } from '../errors.js'
import { StoreTest } from '../store/store-test.js'
import { UsageService, UsageServiceLive } from './usage-service.js'

const TIME = 't'

// A session row, and the project it needs, so turns can point at it
const seedSession = (id: string): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* seedsSession() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at) VALUES ('p', 'p', '/p', 'main', '{}', ${TIME}, ${TIME}) ON CONFLICT DO NOTHING`
    yield* sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, workspace_json, status, created_at) VALUES (${id}, 'p', 't', '{}', 'fake', '{}', 'ready', ${TIME})`
  })

// A turn of a seeded session; null stands for a turn that has reported no usage yet
const seedTurn = (
  sessionId: string,
  index: number,
  usage: string | null,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* seedsTurn() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO turns (id, session_id, idx, prompt_json, status, usage_json, started_at) VALUES (${`${sessionId}-${index}`}, ${sessionId}, ${index}, '{}', 'completed', ${usage}, ${TIME})`
  })

const FIRST = '{"inputTokens":10,"outputTokens":4,"costUsd":0.01,"contextPct":12}'
const SECOND = '{"inputTokens":5,"outputTokens":1}'
const NOTHING = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null, contextPct: null }

const Layers = UsageServiceLive.pipe(Layer.provideMerge(StoreTest))

it.layer(Layers)('UsageService', (suite) => {
  suite.effect(
    'sums turn usage per session and keeps the latest rate-limit snapshot per profile',
    () =>
      Effect.gen(function* summing() {
        yield* seedSession('s')
        yield* seedTurn('s', 0, FIRST)
        yield* seedTurn('s', 1, SECOND)
        const usage = yield* UsageService
        assert.deepStrictEqual(yield* usage.sessionUsage('s'), {
          turns: 2,
          inputTokens: 15,
          outputTokens: 5,
          costUsd: 0.01,
          contextPct: 12,
        })
        yield* usage.record('prof', { fiveHourPct: 40 })
        yield* usage.record('prof', { fiveHourPct: 55, sevenDayPct: 10 })
        const snapshot = yield* usage.snapshot('prof')
        assert.ok(snapshot !== undefined)
        assert.deepStrictEqual(snapshot.rateLimit, { fiveHourPct: 55, sevenDayPct: 10 })
      }),
  )

  suite.effect('reports no cost and no context for a session without turns', () =>
    Effect.gen(function* reportsNothing() {
      yield* seedSession('empty')
      const usage = yield* UsageService
      assert.deepStrictEqual(yield* usage.sessionUsage('empty'), NOTHING)
    }),
  )
})

it.layer(Layers)('UsageService turns', (suite) => {
  suite.effect('counts a turn that has no usage yet and leaves other sessions out', () =>
    Effect.gen(function* countsTurns() {
      yield* seedSession('mine')
      yield* seedSession('other')
      yield* seedTurn('mine', 0, SECOND)
      yield* seedTurn('mine', 1, null)
      yield* seedTurn('other', 0, FIRST)
      const usage = yield* UsageService
      assert.deepStrictEqual(yield* usage.sessionUsage('mine'), {
        ...NOTHING,
        turns: 2,
        inputTokens: 5,
        outputTokens: 1,
      })
    }),
  )

  suite.effect('takes the context percentage of the latest turn that reported one', () =>
    Effect.gen(function* takesLatestContext() {
      yield* seedSession('context')
      yield* seedTurn('context', 0, '{"inputTokens":1,"outputTokens":1,"contextPct":10}')
      yield* seedTurn('context', 1, '{"inputTokens":1,"outputTokens":1,"contextPct":35}')
      yield* seedTurn('context', 2, SECOND)
      const usage = yield* UsageService
      assert.strictEqual((yield* usage.sessionUsage('context')).contextPct, 35)
    }),
  )

  suite.effect('fails with a store error for a turn whose usage cannot be read', () =>
    Effect.gen(function* failsOnCorruption() {
      yield* seedSession('corrupt')
      yield* seedTurn('corrupt', 0, '{"inputTokens":"many"}')
      const usage = yield* UsageService
      const outcome = yield* Effect.result(usage.sessionUsage('corrupt'))
      assert.ok(Result.isFailure(outcome))
      assert.ok(outcome.failure instanceof StoreError)
    }),
  )
})

it.layer(Layers)('UsageService rate limits', (suite) => {
  suite.effect('keeps every field of a rate limit and files a missing profile as default', () =>
    Effect.gen(function* keepsRateLimit() {
      const usage = yield* UsageService
      const full = {
        fiveHourPct: 80,
        fiveHourResetsAt: '2026-10-03T12:00:00.000Z',
        sevenDayPct: 20,
        sevenDayResetsAt: '2026-10-09T00:00:00.000Z',
      }
      yield* usage.record(null, full)
      const snapshot = yield* usage.snapshot('default')
      assert.ok(snapshot !== undefined)
      assert.strictEqual(snapshot.profileId, 'default')
      assert.deepStrictEqual(snapshot.rateLimit, full)
      assert.match(snapshot.observedAt, /^\d{4}-\d{2}-\d{2}T/u)
    }),
  )

  suite.effect('has no snapshot for a profile that never reported', () =>
    Effect.gen(function* hasNone() {
      const usage = yield* UsageService
      assert.strictEqual(yield* usage.snapshot('nobody'), undefined)
    }),
  )
})
