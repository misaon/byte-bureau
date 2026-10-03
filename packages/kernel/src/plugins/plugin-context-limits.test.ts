import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { SqlClient } from 'effect/sql'
import { EventLog } from '../events/event-log.js'
import { flush } from '../sessions/session-helper-fixtures.js'
import { rejected, resolved, takeFrom } from './plugin-call-fixtures.js'
import { hostOver, loadedHost, probe } from './plugin-fixtures.js'

const listener = probe('listener')
const keeper = probe('keeper')

it.layer(hostOver({ extraPlugins: [listener.plugin] }))('plugin context subscriptions', (suite) => {
  suite.effect('hears only what happens after it subscribes, never the history of the log', () =>
    Effect.gen(function* hearsLiveOnly() {
      yield* loadedHost
      const log = yield* EventLog
      yield* log.publish({ type: 'message.user', sessionId: 'live-1', payload: { text: 'before' } })
      const { events } = listener.context()
      const hearing = yield* Effect.forkChild(
        takeFrom(events.subscribe({ sessionId: 'live-1' }), 1),
      )
      yield* flush
      yield* log.publish({ type: 'message.user', sessionId: 'live-1', payload: { text: 'after' } })
      const heard = yield* Fiber.join(hearing)
      assert.deepStrictEqual(
        heard.map((envelope) => envelope.payload),
        [{ text: 'after' }],
      )
    }),
  )
})

it.layer(hostOver({ extraPlugins: [keeper.plugin] }))('plugin context kv failures', (suite) => {
  suite.effect(
    'refuses undefined, a function and a bigint with a TypeError naming the plugin and the key',
    () =>
      Effect.gen(function* refusesValues() {
        yield* loadedHost
        const { kv } = keeper.context()
        const failures = [
          yield* rejected(kv.set('nothing', undefined)),
          yield* rejected(kv.set('callback', () => 1)),
          yield* rejected(kv.set('big', 10n)),
        ]
        assert.ok(failures.every((failure) => failure instanceof TypeError))
        assert.deepStrictEqual(
          failures.map((failure) =>
            failure instanceof Error ? failure.message.split(':')[0] : '',
          ),
          [
            'plugin keeper cannot store nothing',
            'plugin keeper cannot store callback',
            'plugin keeper cannot store big',
          ],
        )
      }),
  )

  suite.effect('names the plugin and the key of a stored value that is not JSON', () =>
    Effect.gen(function* namesCorruptRow() {
      yield* loadedHost
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO plugin_kv (plugin_id, key, value_json) VALUES ('keeper', 'broken', 'not json')`
      const failure = yield* rejected(keeper.context().kv.get('broken'))
      assert.match(
        failure instanceof Error ? failure.message : '',
        /^plugin keeper could not decode broken: /u,
      )
      assert.strictEqual(yield* resolved(keeper.context().kv.get('missing')), undefined)
    }),
  )
})
