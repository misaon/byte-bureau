import type { EventEnvelope, PluginEvents } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { SqlClient } from 'effect/sql'
import { EventLog } from '../events/event-log.js'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import { flush } from '../sessions/session-helper-fixtures.js'
import { rejected, resolved, takeFrom } from './plugin-call-fixtures.js'
import { hostOver, loadedHost, probe } from './plugin-fixtures.js'

const USER = 'message.user'

const alpha = probe('alpha')
const beta = probe('beta')
const extraPlugins = [alpha.plugin, beta.plugin]

it.layer(hostOver({ extraPlugins }))('plugin context kv', (suite) => {
  suite.effect('stores, replaces and deletes a value, and reads a missing key as undefined', () =>
    Effect.gen(function* storesValues() {
      yield* loadedHost
      const { kv } = alpha.context()
      assert.strictEqual(yield* resolved(kv.get('missing')), undefined)
      yield* resolved(kv.set('config', { retries: 3, tags: ['a'] }))
      assert.deepStrictEqual(yield* resolved(kv.get('config')), { retries: 3, tags: ['a'] })
      yield* resolved(kv.set('config', 'replaced'))
      assert.strictEqual(yield* resolved(kv.get('config')), 'replaced')
      yield* resolved(kv.delete('config'))
      assert.strictEqual(yield* resolved(kv.get('config')), undefined)
    }),
  )

  suite.effect('keeps the values of a plugin apart from the values of another', () =>
    Effect.gen(function* separatesPlugins() {
      yield* loadedHost
      yield* resolved(alpha.context().kv.set('shared', 'from alpha'))
      yield* resolved(beta.context().kv.set('shared', 'from beta'))
      const sql = yield* SqlClient.SqlClient
      const rows =
        yield* sql`SELECT plugin_id, key, value_json FROM plugin_kv WHERE key = 'shared' ORDER BY plugin_id`
      assert.deepStrictEqual(rows, [
        { plugin_id: 'alpha', key: 'shared', value_json: '"from alpha"' },
        { plugin_id: 'beta', key: 'shared', value_json: '"from beta"' },
      ])
      assert.strictEqual(yield* resolved(beta.context().kv.get('shared')), 'from beta')
    }),
  )

  suite.effect('rejects a value that cannot be stored instead of throwing', () =>
    Effect.gen(function* rejectsUnsupportedValue() {
      yield* loadedHost
      const failure = yield* rejected(alpha.context().kv.set('big', 10n))
      assert.instanceOf(failure, TypeError)
    }),
  )
})

it.layer(hostOver({ extraPlugins }))('plugin context fields', (suite) => {
  suite.effect('hands the plugin no project, a logger of its own, fetch and a live signal', () =>
    Effect.gen(function* handsFields() {
      yield* loadedHost
      const context = alpha.context()
      assert.strictEqual(context.project, null)
      assert.deepStrictEqual(context.logger.category, ['bb', 'plugin', 'alpha'])
      assert.strictEqual(context.http, fetch)
      assert.isFalse(context.signal.aborted)
    }),
  )
})

const store = new InMemorySecretStore()

it.layer(hostOver({ extraPlugins, secrets: store }))('plugin context secrets', (suite) => {
  suite.effect('keeps the secrets of a plugin apart from the secrets of another', () =>
    Effect.gen(function* separatesSecrets() {
      yield* loadedHost
      yield* resolved(alpha.context().secrets.set('token', 'a1'))
      assert.strictEqual(yield* resolved(beta.context().secrets.get('token')), undefined)
      yield* resolved(beta.context().secrets.set('token', 'b1'))
      assert.strictEqual(yield* resolved(alpha.context().secrets.get('token')), 'a1')
      yield* resolved(alpha.context().secrets.delete('token'))
      assert.strictEqual(yield* resolved(alpha.context().secrets.get('token')), undefined)
      assert.strictEqual(yield* resolved(beta.context().secrets.get('token')), 'b1')
    }),
  )

  suite.effect('keeps them in the store of the host under the name of the plugin', () =>
    Effect.gen(function* keepsUnderName() {
      yield* loadedHost
      yield* resolved(alpha.context().secrets.set('apiKey', 'not-a-real-key'))
      assert.strictEqual(yield* resolved(store.get('alpha/apiKey')), 'not-a-real-key')
    }),
  )
})

// A subscription to everything of the session sub-1 and one to its warnings, taking two and one
const listenTo = (
  events: PluginEvents,
): Effect.Effect<readonly [readonly EventEnvelope[], readonly EventEnvelope[]]> => {
  const whole = events.subscribe({ sessionId: 'sub-1' })
  const typed = events.subscribe({ types: ['session.warning'], sessionId: 'sub-1' })
  return Effect.all([takeFrom(whole, 2), takeFrom(typed, 1)], { concurrency: 2 })
}

// Two events in one session, one of them a warning, and one in another session
const seed = (events: PluginEvents): Effect.Effect<void> =>
  Effect.gen(function* seedsEvents() {
    const warning = { kind: 'k', message: 'm' }
    yield* resolved(events.publish({ type: USER, sessionId: 'sub-1', payload: { text: 'one' } }))
    yield* resolved(
      events.publish({ type: 'session.warning', sessionId: 'sub-1', payload: warning }),
    )
    yield* resolved(events.publish({ type: USER, sessionId: 'sub-2', payload: { text: 'two' } }))
  })

it.layer(hostOver({ extraPlugins }))('plugin context events', (suite) => {
  suite.effect('publishes an event to the log, as the plugin names it', () =>
    Effect.gen(function* publishesEvent() {
      yield* loadedHost
      const event = {
        type: USER,
        sessionId: 'pub-1',
        payload: { text: 'hello' },
      } as const
      yield* resolved(alpha.context().events.publish(event))
      const stored = yield* (yield* EventLog).read({ sessionId: 'pub-1' }, { from: 0 })
      assert.deepStrictEqual(
        stored.map((envelope) => [envelope.type, envelope.payload]),
        [[USER, { text: 'hello' }]],
      )
    }),
  )

  suite.effect('delivers stored envelopes, all of a session or filtered by type', () =>
    Effect.gen(function* deliversEnvelopes() {
      yield* loadedHost
      const { events } = alpha.context()
      const listening = yield* Effect.forkChild(listenTo(events))
      yield* Effect.andThen(flush, seed(events))
      const [wholeEvents, typedEvents] = yield* Fiber.join(listening)
      assert.deepStrictEqual(
        wholeEvents.map((envelope) => envelope.type),
        [USER, 'session.warning'],
      )
      assert.deepStrictEqual(
        typedEvents.map((envelope) => envelope.payload),
        [{ kind: 'k', message: 'm' }],
      )
      assert.isTrue(
        wholeEvents.every(
          (envelope) => envelope.seq > 0 && envelope.id !== '' && envelope.ts !== '',
        ),
      )
    }),
  )
})
