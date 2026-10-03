import type { LogRecord } from '@logtape/logtape'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { configureLogging, resetLogging } from '../logging/logging.js'
import { toolCallsOf } from './session-db-fixtures.js'
import { startSession } from './session-fixtures.js'
import { failingUsage } from './session-gate-fixtures.js'
import { prompted } from './session-prompted-fixtures.js'
import { push } from './session-push-fixtures.js'
import { driven } from './session-script-fixtures.js'

const broken = driven({}, {}, failingUsage())

const LIMIT = { type: 'ratelimit.updated', rateLimit: { fiveHourPct: 80 } } as const
const START = { type: 'tool.started', id: 't1', name: 'Bash', kind: 'bash', input: null } as const
const END = { type: 'tool.completed', id: 't1', outputSummary: 'ok', bytes: 2 } as const

// What the kernel logs while the effect runs; the configuration of the logger is global, so it is reset afterwards
const logged = <Value, Failure, Requirements>(
  work: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<readonly LogRecord[], Failure, Requirements> =>
  Effect.gen(function* capturesLog() {
    const records: LogRecord[] = []
    yield* Effect.promise(async () => {
      await configureLogging({
        level: 'error',
        json: true,
        capture: (record) => {
          records.push(record)
        },
      })
    })
    const reset = Effect.promise(async () => {
      await resetLogging()
    })
    yield* work.pipe(Effect.ensuring(reset))
    return records
  })

it.layer(broken.layer)('SessionManager event that cannot be applied', (suite) => {
  suite.effect('logs the failure and goes on with the events that follow', () =>
    Effect.gen(function* logsAndGoesOn() {
      const session = yield* startSession({ providerId: 'scripted' })
      const { agent } = yield* prompted(broken, session)
      const records = yield* logged(push(session.id, agent, LIMIT, START, END))
      assert.deepStrictEqual(
        (yield* toolCallsOf(session.id)).map((row) => row.status),
        ['completed'],
      )
      const [record] = records
      assert.ok(record !== undefined)
      assert.deepStrictEqual(
        [record.message[0], record.properties['sessionId'], record.properties['event']],
        ['session work failed', session.id, 'ratelimit.updated'],
      )
      assert.match(String(record.properties['cause']), /the disk is full/u)
    }),
  )
})
