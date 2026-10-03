import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  hostOver,
  loadedHost,
  manifestOf,
  probe,
  providerOf,
  runtimeOf,
  statusOf,
} from './plugin-fixtures.js'

// What a plugin written in plain JavaScript can be
const shapeless: unknown = { setup: () => ({}) }
const unnamed: unknown = { manifest: { version: '1.0.0', hostApi: '^0' }, setup: () => ({}) }
const isPlugin = (value: unknown): value is Plugin => typeof value === 'object' && value !== null

const dotted = definePlugin({ manifest: manifestOf('a.b'), setup: () => ({}) })
const doubled = definePlugin({
  manifest: manifestOf('doubled'),
  setup: () => ({ agentProviders: [providerOf('twice'), providerOf('twice')] }),
})
const doubledRuntime = definePlugin({
  manifest: manifestOf('doubled-runtime'),
  setup: () => ({ workspaceRuntimes: [runtimeOf('again'), runtimeOf('again')] }),
})
const reserved = probe('constructor')
const inheriting = probe('inheriting')
const malformed = [shapeless, unnamed].filter((value) => isPlugin(value))

const extraPlugins = [
  ...malformed,
  dotted,
  doubled,
  doubledRuntime,
  reserved.plugin,
  inheriting.plugin,
]

// A configuration object whose entry for the plugin is inherited, not its own
function inheritedConfig(): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  Reflect.setPrototypeOf(config, { inheriting: { from: 'prototype' } })
  return config
}

const pluginConfig = inheritedConfig()

it.layer(hostOver({ extraPlugins, pluginConfig }))('PluginHost admission', (suite) => {
  suite.effect('refuses a plugin without a manifest or a name, and goes on with the others', () =>
    Effect.gen(function* refusesShapeless() {
      const host = yield* loadedHost
      const unnamedStatuses = host.plugins().filter((status) => status.name === '(unnamed)')
      assert.deepStrictEqual(
        unnamedStatuses.map((status) => [status.state, status.reason]),
        [
          ['failed', 'a plugin needs a manifest object and a setup function'],
          ['failed', 'the manifest has no name'],
        ],
      )
      assert.strictEqual(statusOf(host, 'inheriting').state, 'loaded')
    }),
  )

  suite.effect(
    'refuses a plugin name that is not lower-case letters, digits and dashes, or is reserved',
    () =>
      Effect.gen(function* refusesName() {
        const host = yield* loadedHost
        assert.deepStrictEqual(
          [statusOf(host, 'a.b').reason, statusOf(host, 'constructor').reason],
          [
            'the plugin name a.b is not lower-case letters, digits and dashes',
            'the plugin name constructor is reserved',
          ],
        )
      }),
  )
})

it.layer(hostOver({ extraPlugins, pluginConfig }))(
  'PluginHost admission of registrations',
  (suite) => {
    suite.effect('refuses a registration that offers one provider or runtime id twice', () =>
      Effect.gen(function* refusesTwice() {
        const host = yield* loadedHost
        assert.deepStrictEqual(
          [statusOf(host, 'doubled').reason, statusOf(host, 'doubled-runtime').reason],
          [
            'agentProviders:twice is offered twice by one registration',
            'workspaceRuntimes:again is offered twice by one registration',
          ],
        )
        assert.strictEqual(host.agentProvider('twice'), undefined)
      }),
    )

    suite.effect(
      'gives a plugin only a configuration entry of its own, never an inherited one',
      () =>
        Effect.gen(function* looksUpOwnConfig() {
          yield* loadedHost
          assert.strictEqual(inheriting.context().config, undefined)
        }),
    )
  },
)
