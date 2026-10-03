import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { toolCallsOf } from './session-db-fixtures.js'
import { payloadsOf, startSession } from './session-fixtures.js'
import { firstOf } from './session-helper-fixtures.js'
import { prompted } from './session-prompted-fixtures.js'
import { FINISH, push } from './session-push-fixtures.js'
import { driven } from './session-script-fixtures.js'

const world = driven()

const BASH_START = {
  type: 'tool.started',
  id: 't1',
  name: 'Bash',
  kind: 'bash',
  input: { command: 'ls' },
} as const
const BASH_END = { type: 'tool.completed', id: 't1', outputSummary: 'ok', bytes: 2 } as const
const READ_START = {
  type: 'tool.started',
  id: 't2',
  name: 'Read',
  kind: 'builtin',
  input: null,
} as const
const READ_FAIL = { type: 'tool.failed', id: 't2', error: 'boom' } as const
it.layer(world.layer)('SessionManager tool calls', (suite) => {
  suite.effect('records a tool call from its start to its end', () =>
    Effect.gen(function* recordsToolCall() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { turn, agent } = yield* prompted(world, session)
      yield* push(session.id, agent, BASH_START, BASH_END)
      assert.deepStrictEqual(yield* toolCallsOf(session.id), [
        {
          tool_name: 'Bash',
          kind: 'bash',
          status: 'completed',
          output_summary: 'ok',
          input_bytes: 16,
          output_bytes: 2,
          turn_id: turn.id,
        },
      ])
    }),
  )

  suite.effect('names the end of a call after its start', () =>
    Effect.gen(function* namesEnd() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(world, session)
      yield* push(session.id, agent, BASH_START, BASH_END)
      assert.deepStrictEqual(yield* payloadsOf(session.id, 'tool.completed'), [
        { id: 't1', name: 'Bash', outputSummary: 'ok', bytes: 2 },
      ])
    }),
  )
})

it.layer(world.layer)('SessionManager the end of an unknown tool call', (suite) => {
  suite.effect('tells of it without a name and keeps no record of it', () =>
    Effect.gen(function* tellsOfUnknownCall() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(world, session)
      yield* push(session.id, agent, BASH_END)
      assert.deepStrictEqual(yield* toolCallsOf(session.id), [])
      assert.deepStrictEqual(yield* payloadsOf(session.id, 'tool.completed'), [
        { id: 't1', name: '', outputSummary: 'ok', bytes: 2 },
      ])
    }),
  )
})

it.layer(world.layer)('SessionManager failed tool calls', (suite) => {
  suite.effect('records a failed tool call with its error and names it as well', () =>
    Effect.gen(function* recordsFailure() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(world, session)
      yield* push(session.id, agent, READ_START, READ_FAIL)
      const row = yield* firstOf(yield* toolCallsOf(session.id))
      assert.deepStrictEqual(
        [row.status, row.output_summary, row.output_bytes],
        ['failed', 'boom', 0],
      )
      assert.deepStrictEqual(yield* payloadsOf(session.id, 'tool.failed'), [
        { id: 't2', name: 'Read', error: 'boom' },
      ])
    }),
  )

  suite.effect('keeps two calls apart that a provider gave the same id in different turns', () =>
    Effect.gen(function* keepsCallsApart() {
      const session = yield* startSession({ providerId: 'scripted' })
      const first = yield* prompted(world, session)
      yield* push(session.id, first.agent, BASH_START, BASH_END, FINISH)
      yield* prompted(world, session)
      yield* push(session.id, first.agent, BASH_START, BASH_END)
      const rows = yield* toolCallsOf(session.id)
      assert.deepStrictEqual(
        rows.map((row) => row.status),
        ['completed', 'completed'],
      )
    }),
  )
})
