import path from 'node:path'
import { ProviderConfigError } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ConfigError } from '../errors.js'
import { turnsOf } from './session-db-fixtures.js'
import { sessionOf, startSession } from './session-fixtures.js'
import { SessionManager } from './session-manager.js'
import { driven } from './session-script-fixtures.js'

const misconfigured = driven({
  startFailure: new ProviderConfigError('providers.scripted: colour: unknown key'),
})

it.layer(misconfigured.layer)('SessionManager provider that cannot use its section', (suite) => {
  suite.effect(
    'refuses the prompt as an error of the project file, not a crash, and leaves the session ready',
    () =>
      Effect.gen(function* refusesConfiguration() {
        const sessions = yield* SessionManager
        const session = yield* startSession({ providerId: 'scripted' })
        const error = yield* Effect.flip(sessions.prompt(session.id, { text: 'go' }))
        assert.ok(error instanceof ConfigError)
        assert.deepStrictEqual(
          [path.basename(error.file), error.pointer, error.reason],
          ['bytebureau.json', '', 'providers.scripted: colour: unknown key'],
        )
        assert.strictEqual((yield* sessionOf(session.id)).status, 'ready')
        assert.deepStrictEqual(yield* turnsOf(session.id), [])
      }),
  )
})
