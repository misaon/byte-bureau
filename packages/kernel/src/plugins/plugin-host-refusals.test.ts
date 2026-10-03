import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { vi } from 'vitest'
import {
  hostOver,
  loadedHost,
  manifestOf,
  noting,
  providerOf,
  runtimeOf,
  statusOf,
} from './plugin-fixtures.js'

const setups: string[] = []
const journal: string[] = []

const ranged: Plugin = { manifest: manifestOf('ranged', { hostApi: '>=0' }), setup: () => ({}) }
const late: Plugin = {
  manifest: manifestOf('late'),
  setup: async () => {
    await Promise.resolve()
    throw new Error('late failure')
  },
}

// A mock without an answer returns nothing, as a plugin in plain JavaScript can
const forgetful: Plugin = { manifest: manifestOf('forgetful'), setup: vi.fn<Plugin['setup']>() }

const twin = (label: string): Plugin => ({
  manifest: manifestOf('twin'),
  setup: () => {
    setups.push(label)
    return {}
  },
})

const heldProvider = providerOf('shared')
const holder = definePlugin({
  manifest: manifestOf('holder'),
  setup: () => ({
    agentProviders: [heldProvider],
    hooks: { 'prompt.beforeSend': noting(journal, 'holder hook') },
  }),
})
const rival = definePlugin({
  manifest: manifestOf('rival'),
  setup: () => ({
    agentProviders: [providerOf('shared')],
    hooks: { 'prompt.beforeSend': noting(journal, 'rival hook') },
    dispose: async (): Promise<void> => {
      await Promise.resolve()
      journal.push('rival disposed')
    },
  }),
})
const impostor = runtimeOf('local')
const intruder = definePlugin({
  manifest: manifestOf('intruder'),
  setup: () => ({ workspaceRuntimes: [impostor] }),
})

it.layer(hostOver({ extraPlugins: [ranged, late, forgetful] }))('PluginHost refusals', (suite) => {
  suite.effect('refuses a host API that is not a caret range, naming both versions', () =>
    Effect.gen(function* refusesRange() {
      const host = yield* loadedHost
      assert.strictEqual(statusOf(host, 'ranged').state, 'failed')
      assert.strictEqual(
        statusOf(host, 'ranged').reason,
        'plugin ranged needs host API >=0, this ByteBureau provides 0.0.0',
      )
    }),
  )

  suite.effect('refuses a plugin whose setup rejects, with the reason it gave', () =>
    Effect.gen(function* refusesRejection() {
      const host = yield* loadedHost
      assert.strictEqual(statusOf(host, 'late').state, 'failed')
      assert.strictEqual(statusOf(host, 'late').reason, 'late failure')
    }),
  )

  suite.effect('refuses a plugin whose setup returns no registration', () =>
    Effect.gen(function* refusesNothing() {
      const host = yield* loadedHost
      assert.strictEqual(statusOf(host, 'forgetful').state, 'failed')
      assert.strictEqual(
        statusOf(host, 'forgetful').reason,
        'plugin forgetful returned no registration from setup',
      )
    }),
  )
})

it.layer(hostOver({ extraPlugins: [twin('first'), twin('second')] }))(
  'PluginHost duplicates',
  (suite) => {
    suite.effect('refuses a second plugin of the same name without setting it up', () =>
      Effect.gen(function* refusesTwin() {
        const host = yield* loadedHost
        const twins = host.plugins().filter((status) => status.name === 'twin')
        assert.deepStrictEqual(
          twins.map((status) => [status.state, status.reason]),
          [
            ['loaded', undefined],
            ['failed', 'a plugin named twin is already loaded'],
          ],
        )
        assert.deepStrictEqual(setups, ['first'])
      }),
    )
  },
)

it.layer(hostOver({ extraPlugins: [holder, rival, intruder] }))(
  'PluginHost port conflicts',
  (suite) => {
    suite.effect(
      'refuses a plugin whose provider is taken, disposes it and leaves its hooks out',
      () =>
        Effect.gen(function* refusesTakenProvider() {
          const host = yield* loadedHost
          assert.strictEqual(statusOf(host, 'holder').state, 'loaded')
          assert.strictEqual(statusOf(host, 'rival').state, 'failed')
          assert.strictEqual(
            statusOf(host, 'rival').reason,
            'agentProviders:shared is already provided by plugin holder',
          )
          assert.strictEqual(host.agentProvider('shared'), heldProvider)
          yield* host.hooks.run(
            'prompt.beforeSend',
            { sessionId: 's', input: { text: 'x' } },
            (input) => Effect.succeed(input),
          )
          assert.deepStrictEqual(journal, ['rival disposed', 'holder hook'])
        }),
    )

    suite.effect('refuses a plugin that offers the runtime of a bundled one', () =>
      Effect.gen(function* refusesTakenRuntime() {
        const host = yield* loadedHost
        assert.strictEqual(
          statusOf(host, 'intruder').reason,
          'workspaceRuntimes:local is already provided by plugin workspace-local',
        )
        assert.strictEqual(host.workspaceRuntimes().length, 1)
        assert.notStrictEqual(host.workspaceRuntimes()[0], impostor)
      }),
    )
  },
)
