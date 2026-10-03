import type { PluginManifest } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { hostOver, loadedHost, probe, statusOf } from './plugin-fixtures.js'

type Schema = NonNullable<PluginManifest['config']>

const schemaOf = (validate: Schema['~standard']['validate']): Schema => ({
  '~standard': { version: 1, vendor: 'bytebureau-test', validate },
})

// Wants { flag: boolean } and adds a default of its own
const flagSchema = schemaOf((value) =>
  typeof value === 'object' && value !== null && 'flag' in value && typeof value.flag === 'boolean'
    ? { value: { flag: value.flag, extra: 'default' } }
    : { issues: [{ message: 'expected a boolean', path: ['flag'] }] },
)

const strict = probe('strict', {}, { config: flagSchema })
const valid = probe('valid', {}, { config: flagSchema })
const later = probe(
  'later',
  {},
  {
    config: schemaOf(async () => {
      await Promise.resolve()
      return { value: 'resolved later' }
    }),
  },
)
const defaulted = probe(
  'defaulted',
  {},
  { config: schemaOf((value) => ({ value: { seen: value } })) },
)
const bare = probe('bare')
const plain = probe('plain')
const nested = probe(
  'nested',
  {},
  {
    config: schemaOf(() => ({
      issues: [
        { message: 'too deep', path: [{ key: 'nested' }, 'leaf'] },
        { message: 'no path here' },
      ],
    })),
  },
)
const throwing = probe(
  'throwing',
  {},
  {
    config: schemaOf(() => {
      throw new Error('schema blew up')
    }),
  },
)

const extraPlugins = [strict, valid, later, defaulted, bare, plain, nested, throwing].map(
  (candidate) => candidate.plugin,
)
const pluginConfig = { strict: { flag: 'yes' }, valid: { flag: true }, bare: { anything: 1 } }

it.layer(hostOver({ extraPlugins, pluginConfig }))('PluginHost config', (suite) => {
  suite.effect(
    'refuses a plugin whose config the schema rejects, says where, and sets it up never',
    () =>
      Effect.gen(function* refusesInvalidConfig() {
        const host = yield* loadedHost
        assert.strictEqual(statusOf(host, 'strict').state, 'failed')
        assert.strictEqual(
          statusOf(host, 'strict').reason,
          'config invalid: flag expected a boolean',
        )
        assert.throws(() => {
          strict.context()
        }, 'has not been set up')
      }),
  )

  suite.effect(
    'hands the plugin what the schema made of its config: sync, async and defaulted',
    () =>
      Effect.gen(function* handsValidatedConfig() {
        yield* loadedHost
        assert.deepStrictEqual(valid.context().config, { flag: true, extra: 'default' })
        assert.strictEqual(later.context().config, 'resolved later')
        assert.deepStrictEqual(defaulted.context().config, { seen: {} })
      }),
  )

  suite.effect('hands over the config as it is when the plugin has no schema', () =>
    Effect.gen(function* handsRawConfig() {
      yield* loadedHost
      assert.deepStrictEqual(bare.context().config, { anything: 1 })
      assert.strictEqual(plain.context().config, undefined)
    }),
  )
})

it.layer(hostOver({ extraPlugins, pluginConfig }))('PluginHost config issues', (suite) => {
  suite.effect('lists every issue, a nested path in dots and an issue without a path bare', () =>
    Effect.gen(function* listsIssues() {
      const host = yield* loadedHost
      assert.strictEqual(
        statusOf(host, 'nested').reason,
        'config invalid: nested.leaf too deep; no path here',
      )
    }),
  )

  suite.effect('refuses a plugin whose schema throws, with what it threw', () =>
    Effect.gen(function* refusesThrowingSchema() {
      const host = yield* loadedHost
      assert.strictEqual(statusOf(host, 'throwing').reason, 'schema blew up')
    }),
  )
})
