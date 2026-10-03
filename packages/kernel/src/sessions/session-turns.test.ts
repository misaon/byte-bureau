import { assert, it } from '@effect/vitest'
import { Effect, Fiber, Stream } from 'effect'
import { EventLog } from '../events/event-log.js'
import { UsageService } from '../usage/usage-service.js'
import { messagesOf, seedProfile, turnsOf } from './session-db-fixtures.js'
import { payloadsOf, startSession } from './session-fixtures.js'
import { firstOf } from './session-helpers.js'
import { prompted } from './session-prompted-fixtures.js'
import { push } from './session-push-fixtures.js'
import { driven } from './session-script-fixtures.js'

const world = driven()

const USAGE = { inputTokens: 7, outputTokens: 3, costUsd: 0.5, contextPct: 20 }
const FINISH = { type: 'turn.completed', stopReason: 'end_turn', usage: USAGE } as const
const CONTENT = [{ type: 'text', text: 'Hi' }]

it.layer(world.layer)('SessionManager messages and turns', (suite) => {
  suite.effect(
    'keeps what the assistant says as a message and ignores what the user is said to say',
    () =>
      Effect.gen(function* keepsMessages() {
        const session = yield* startSession({ providerId: 'scripted' })
        const { agent } = yield* prompted(world, session, { text: 'Hello' })
        yield* push(
          session.id,
          agent,
          { type: 'message.completed', role: 'assistant', content: CONTENT, text: 'Hi' },
          { type: 'message.completed', role: 'user', content: CONTENT, text: 'echo' },
        )
        const rows = yield* messagesOf(session.id)
        assert.deepStrictEqual(
          rows.map((row) => [row.role, row.content_json]),
          [
            ['user', '[{"type":"text","text":"Hello"}]'],
            ['assistant', '[{"type":"text","text":"Hi"}]'],
          ],
        )
        assert.strictEqual((yield* payloadsOf(session.id, 'message.assistant.completed')).length, 1)
      }),
  )

  suite.effect('ends a turn with its usage and tells of it', () =>
    Effect.gen(function* endsTurn() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { turn, agent } = yield* prompted(world, session)
      yield* push(session.id, agent, FINISH)
      const row = yield* firstOf(yield* turnsOf(session.id))
      assert.deepStrictEqual(
        [row.status, row.stop_reason, row.usage_json],
        ['completed', 'end_turn', JSON.stringify(USAGE)],
      )
      assert.deepStrictEqual(yield* payloadsOf(session.id, 'turn.completed'), [
        { turnId: turn.id, index: 0, status: 'completed', stopReason: 'end_turn', usage: USAGE },
      ])
    }),
  )
})

it.layer(world.layer)('SessionManager usage', (suite) => {
  suite.effect('keeps the end of each turn apart and adds up their usage', () =>
    Effect.gen(function* addsUpTurns() {
      const session = yield* startSession({ providerId: 'scripted' })
      const first = yield* prompted(world, session)
      yield* push(session.id, first.agent, FINISH)
      yield* prompted(world, session, { text: 'again' })
      yield* push(session.id, first.agent, {
        ...FINISH,
        usage: { inputTokens: 1, outputTokens: 2 },
      })
      const rows = yield* turnsOf(session.id)
      assert.deepStrictEqual(
        rows.map((row) => row.usage_json),
        [JSON.stringify(USAGE), '{"inputTokens":1,"outputTokens":2}'],
      )
      const usage = yield* UsageService
      assert.deepStrictEqual(yield* usage.sessionUsage(session.id), {
        turns: 2,
        inputTokens: 8,
        outputTokens: 5,
        costUsd: 0.5,
        contextPct: 20,
      })
    }),
  )

  suite.effect('counts the usage of its turns', () =>
    Effect.gen(function* countsUsage() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(world, session)
      yield* push(session.id, agent, FINISH)
      const usage = yield* UsageService
      assert.deepStrictEqual(yield* usage.sessionUsage(session.id), {
        turns: 1,
        inputTokens: 7,
        outputTokens: 3,
        costUsd: 0.5,
        contextPct: 20,
      })
    }),
  )
})

it.layer(world.layer)('SessionManager rate limits', (suite) => {
  suite.effect(
    'files a rate limit under the profile of the session and tells the profile in the event',
    () =>
      Effect.gen(function* filesRateLimit() {
        yield* seedProfile('prof-1')
        const session = yield* startSession({ providerId: 'scripted', profileId: 'prof-1' })
        const { agent } = yield* prompted(world, session)
        yield* push(session.id, agent, {
          type: 'ratelimit.updated',
          rateLimit: { fiveHourPct: 42 },
        })
        const snapshot = yield* (yield* UsageService).snapshot('prof-1')
        assert.deepStrictEqual(snapshot === undefined ? null : snapshot.rateLimit, {
          fiveHourPct: 42,
        })
        assert.deepStrictEqual(yield* payloadsOf(session.id, 'ratelimit.updated'), [
          { profileId: 'prof-1', rateLimit: { fiveHourPct: 42 } },
        ])
      }),
  )

  suite.effect('files a rate limit of a session without a profile under the default one', () =>
    Effect.gen(function* filesDefaultRateLimit() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(world, session)
      yield* push(session.id, agent, { type: 'ratelimit.updated', rateLimit: { sevenDayPct: 9 } })
      const snapshot = yield* (yield* UsageService).snapshot('default')
      assert.deepStrictEqual(snapshot === undefined ? null : snapshot.rateLimit, { sevenDayPct: 9 })
    }),
  )
})

it.layer(world.layer)('SessionManager deltas', (suite) => {
  suite.effect('hands a delta to those who watch and leaves it out of the log', () =>
    Effect.gen(function* handsDelta() {
      const log = yield* EventLog
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(world, session)
      const watched = log.subscribe({ sessionId: session.id, types: ['message.assistant.delta'] })
      const watcher = yield* Effect.forkChild(Stream.runCollect(Stream.take(watched, 1)))
      yield* Effect.yieldNow
      yield* push(session.id, agent, { type: 'message.delta', kind: 'text', text: 'Hel' })
      const seen = yield* Fiber.join(watcher)
      assert.deepStrictEqual(
        seen.map((event) => event.payload),
        [{ kind: 'text', text: 'Hel' }],
      )
      assert.deepStrictEqual(yield* payloadsOf(session.id, 'message.assistant.delta'), [])
    }),
  )
})
