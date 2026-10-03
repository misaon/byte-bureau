import type { AgentEvent } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import { toolCallsOf, turnsOf } from './session-db-fixtures.js'
import { payloadsOf, startSession, typesOf } from './session-fixtures.js'
import { countOf } from './session-helpers.js'
import { prompted } from './session-prompted-fixtures.js'
import { SessionManager } from './session-manager.js'
import { push } from './session-push-fixtures.js'
import { driven } from './session-script-fixtures.js'

const world = driven()

const NUMBERS = [...Array.from({ length: 60 }).keys()]

const idOf = (payload: unknown): string =>
  typeof payload === 'object' &&
  payload !== null &&
  'id' in payload &&
  typeof payload.id === 'string'
    ? payload.id
    : ''

// A tool call that starts and ends, under an id of its own
const callNumber = (index: number): readonly AgentEvent[] => [
  { type: 'tool.started', id: `t${index}`, name: 'Bash', kind: 'bash', input: { index } },
  { type: 'tool.completed', id: `t${index}`, outputSummary: 'ok', bytes: 2 },
]

// How many provider sessions the kernel has started for a session
const startedFor = (sessionId: string): number =>
  world.scripted.sessions.filter((agent) => agent.request.sessionId === sessionId).length

it.layer(world.layer)('SessionManager simultaneous commands', (suite) => {
  suite.effect('lets exactly one of two simultaneous prompts through', () =>
    Effect.gen(function* letsOneThrough() {
      const sessions = yield* SessionManager
      const session = yield* startSession({ providerId: 'scripted' })
      const attempts = [{ text: 'a' }, { text: 'b' }].map((input) =>
        Effect.result(sessions.prompt(session.id, input)),
      )
      const outcomes = yield* Effect.all(attempts, { concurrency: 'unbounded' })
      assert.strictEqual(outcomes.filter((outcome) => Result.isSuccess(outcome)).length, 1)
      assert.strictEqual(startedFor(session.id), 1)
      assert.strictEqual((yield* turnsOf(session.id)).length, 1)
      assert.strictEqual(countOf(yield* typesOf(session.id), 'session.running'), 1)
    }),
  )

  suite.effect('applies a burst of events in the order they were sent', () =>
    Effect.gen(function* appliesInOrder() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(world, session)
      yield* push(session.id, agent, ...NUMBERS.flatMap((index) => callNumber(index)))
      const started = yield* payloadsOf(session.id, 'tool.started')
      const rows = yield* toolCallsOf(session.id)
      assert.deepStrictEqual(
        started.map((payload) => idOf(payload)),
        NUMBERS.map((index) => `t${index}`),
      )
      assert.deepStrictEqual(
        rows.map((row) => row.status),
        NUMBERS.map(() => 'completed'),
      )
    }),
  )
})
