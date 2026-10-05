import path from 'node:path'
import { ProviderConfigError } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ConfigError } from '../errors.js'
import { refusedIn, toldOf } from './session-refusal-fixtures.js'
import { driven } from './session-script-fixtures.js'

const UNKNOWN_KEY = 'providers.scripted: colour: unknown key'
const DEVELOPER = {
  name: 'Developer',
  provider: 'scripted',
  model: 'm',
  permissionMode: 'supervised',
}
const BARE = { version: 1, project: { name: 'configured' }, employees: { developer: DEVELOPER } }
const SECTION = { providers: { scripted: { colour: 'blue' } } }

const misconfigured = driven({ startFailure: new ProviderConfigError(UNKNOWN_KEY) })

it.layer(misconfigured.layer)('SessionManager provider that cannot use its section', (suite) => {
  suite.effect(
    'refuses the prompt as an error of the configuration, not a crash, naming no file that does not set the section',
    () =>
      Effect.gen(function* refusesUnset() {
        const refused = yield* refusedIn(BARE)
        assert.deepStrictEqual(
          [toldOf(refused), refused.turns],
          [["the project's configuration", '', UNKNOWN_KEY], 0],
        )
      }),
  )

  suite.effect(
    'names the one file that sets the section, the project file or the local one, and neither when both do',
    () =>
      Effect.gen(function* refusesBySource() {
        const project = yield* refusedIn({ ...BARE, ...SECTION })
        const local = yield* refusedIn(BARE, SECTION)
        const both = yield* refusedIn({ ...BARE, ...SECTION }, SECTION)
        assert.deepStrictEqual(
          [toldOf(project)[0], toldOf(local)[0], toldOf(both)[0]],
          [
            path.join(project.repo, 'bytebureau.json'),
            path.join(local.repo, 'bytebureau.local.json'),
            "the project's configuration",
          ],
        )
      }),
  )
})

// The error of a plugin that brings a copy of the plugin-api of its own: another class, the same name
const copied = driven({
  startFailure: Object.assign(new Error(UNKNOWN_KEY), {
    name: 'ProviderConfigError',
    reason: UNKNOWN_KEY,
  }),
})

it.layer(copied.layer)(
  'SessionManager provider whose configuration error comes from another copy of the plugin-api',
  (suite) => {
    suite.effect('tells it as a configuration error by its name', () =>
      Effect.gen(function* refusesByName() {
        const refused = yield* refusedIn(BARE)
        assert.ok(refused.error instanceof ConfigError)
        assert.deepStrictEqual(toldOf(refused), ["the project's configuration", '', UNKNOWN_KEY])
      }),
    )
  },
)
