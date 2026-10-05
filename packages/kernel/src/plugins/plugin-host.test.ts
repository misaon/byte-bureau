import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { EventLog } from '../events/event-log.js'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import { WorkspaceRuntimes } from '../workspace/runtimes.js'
import { BUNDLED_PLUGINS } from './bundled.js'
import {
  hostOver,
  loadedHost,
  manifestOf,
  passOn,
  providerOf,
  statusOf,
} from './plugin-fixtures.js'
import { PluginHost } from './plugin-host.js'

const good = definePlugin({
  manifest: manifestOf('good', { contributes: { agentProviders: ['good'] } }),
  setup: (context) => ({
    agentProviders: [providerOf('good')],
    hooks: { 'prompt.beforeSend': passOn },
    dispose: async (): Promise<void> => {
      await context.kv.set('disposed', true)
    },
  }),
})
const vault = definePlugin({
  manifest: manifestOf('vault'),
  setup: () => ({ secretStores: [new InMemorySecretStore()] }),
})
const broken: Plugin = {
  manifest: manifestOf('broken'),
  setup: () => {
    throw new Error('setup failed')
  },
}
const incompatible: Plugin = {
  manifest: manifestOf('future', { hostApi: '^9' }),
  setup: () => ({}),
}

const REFUSAL = 'plugin future needs host API ^9, this ByteBureau provides 0.0.0'
const LOADED = 'plugin.loaded'
const FAILED = 'plugin.failed'
const OUTCOMES = { types: [LOADED, FAILED] }
const BUNDLED = BUNDLED_PLUGINS.length

it.layer(hostOver({ extraPlugins: [good, broken, incompatible] }))('PluginHost', (suite) => {
  suite.effect('loads bundled and extra plugins, records failures and keeps running', () =>
    Effect.gen(function* loadsPlugins() {
      const host = yield* loadedHost
      assert.strictEqual(statusOf(host, 'workspace-local').state, 'loaded')
      assert.strictEqual(statusOf(host, 'good').state, 'loaded')
      assert.strictEqual(statusOf(host, 'broken').state, 'failed')
      assert.match(statusOf(host, 'future').reason ?? '', /\^9.*0\.0\.0/u)
      assert.ok(host.agentProvider('good') !== undefined)
      assert.ok((yield* WorkspaceRuntimes).get('local') !== undefined)
      const events = yield* (yield* EventLog).read(OUTCOMES, { from: 0 })
      const loaded = [...BUNDLED_PLUGINS, good].map(() => LOADED)
      assert.deepStrictEqual(events.map((event) => event.type).toSorted(), [
        FAILED,
        FAILED,
        ...loaded,
      ])
    }),
  )
})

it.layer(hostOver({ extraPlugins: [good, broken, incompatible] }))('PluginHost record', (suite) => {
  suite.effect('lists the bundled plugins first, then the extra ones with ports or reasons', () =>
    Effect.gen(function* listsPlugins() {
      const host = yield* loadedHost
      const bundled = host.plugins().slice(0, BUNDLED)
      assert.deepStrictEqual(
        bundled.map((status) => [status.name, status.state]),
        [
          ['workspace-local', 'loaded'],
          ['agent-fake', 'loaded'],
          ['agent-claude', 'loaded'],
          ['agent-acp', 'loaded'],
        ],
      )
      assert.deepStrictEqual(host.plugins().slice(BUNDLED), [
        { name: 'good', version: '1.0.0', state: 'loaded', ports: ['agentProviders:good'] },
        { name: 'broken', version: '1.0.0', state: 'failed', reason: 'setup failed', ports: [] },
        { name: 'future', version: '1.0.0', state: 'failed', reason: REFUSAL, ports: [] },
      ])
    }),
  )

  suite.effect('announces each outcome in the log, in the same order', () =>
    Effect.gen(function* announcesOutcomes() {
      yield* loadedHost
      const events = yield* (yield* EventLog).read(OUTCOMES, { from: 0 })
      assert.deepStrictEqual(
        events.slice(0, BUNDLED).map((event) => event.type),
        BUNDLED_PLUGINS.map(() => LOADED),
      )
      assert.deepStrictEqual(
        events.slice(BUNDLED).map((event) => [event.type, event.payload]),
        [
          [LOADED, { name: 'good', version: '1.0.0', ports: ['agentProviders:good'] }],
          [FAILED, { name: 'broken', reason: 'setup failed' }],
          [FAILED, { name: 'future', reason: REFUSAL }],
        ],
      )
    }),
  )
})

it.layer(hostOver({ extraPlugins: [good, vault] }))('PluginHost ports', (suite) => {
  suite.effect('lists agent providers and workspace runtimes, on the host and as services', () =>
    Effect.gen(function* listsPorts() {
      const host = yield* loadedHost
      const runtimes = yield* WorkspaceRuntimes
      assert.include(
        host.agentProviders().map((provider) => provider.id),
        'good',
      )
      assert.strictEqual(host.agentProvider('nobody'), undefined)
      assert.deepStrictEqual(
        host.workspaceRuntimes().map((runtime) => runtime.id),
        ['local'],
      )
      assert.deepStrictEqual(runtimes.list(), host.workspaceRuntimes())
      assert.strictEqual(runtimes.get('local'), host.workspaceRuntimes()[0])
      assert.strictEqual(runtimes.get('nobody'), undefined)
    }),
  )

  suite.effect('reports a secret store as a port without an id', () =>
    Effect.gen(function* reportsSecretStore() {
      const host = yield* loadedHost
      assert.deepStrictEqual(statusOf(host, 'vault').ports, ['secretStores'])
    }),
  )
})

it.layer(hostOver({ extraPlugins: [good] }))('PluginHost before load', (suite) => {
  suite.effect('registers and announces nothing until load is called', () =>
    Effect.gen(function* waitsForLoad() {
      const host = yield* PluginHost
      const events = yield* (yield* EventLog).read({}, { from: 0 })
      assert.deepStrictEqual(host.plugins(), [])
      assert.deepStrictEqual(host.agentProviders(), [])
      assert.deepStrictEqual(host.workspaceRuntimes(), [])
      assert.deepStrictEqual(events, [])
    }),
  )
})
