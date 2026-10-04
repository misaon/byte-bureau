import { assert, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { StoreTest } from '../store/store-test.js'
import { EventLog, EventLogLive } from './event-log.js'

it.layer(EventLogLive.pipe(Layer.provideMerge(StoreTest)))('EventLog redaction', (suite) => {
  suite.effect('stores and fans out a payload with its secrets replaced', () =>
    Effect.gen(function* redacts() {
      const log = yield* EventLog
      const published = yield* log.publish({
        type: 'tool.started',
        payload: {
          id: 't1',
          name: 'Bash',
          kind: 'bash',
          input: { command: 'export GITHUB_TOKEN=ghp_abcdefghijklmnop', token: 'x' },
        },
      })
      const expected = {
        id: 't1',
        name: 'Bash',
        kind: 'bash',
        input: { command: 'export GITHUB_TOKEN=[REDACTED]', token: '[REDACTED]' },
      }
      assert.deepStrictEqual(published.payload, expected)
      const [stored] = yield* log.read({}, { from: 0 })
      assert.deepStrictEqual(stored === undefined ? undefined : stored.payload, expected)
    }),
  )
})
