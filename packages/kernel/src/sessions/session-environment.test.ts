import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { withEnv } from '../process/supervisor-fixtures.js'
import { startSession } from './session-fixtures.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import { driven } from './session-script-fixtures.js'

const DEVELOPER = {
  name: 'Developer',
  provider: 'scripted',
  model: 'm',
  permissionMode: 'supervised',
}
const CONFIG = {
  version: 1,
  project: { name: 'passing' },
  employees: { developer: DEVELOPER },
  providers: { scripted: { passEnv: ['BB_PASSED'], other: 'for the plugin' } },
}

const world = driven()

it.layer(world.layer)('SessionManager passEnv of a provider', (suite) => {
  suite.effect('passes the variables the provider names in passEnv, and no other', () =>
    Effect.gen(function* passesNamedVariables() {
      yield* withEnv('BB_PASSED', 'yes')
      yield* withEnv('BB_NOT_NAMED', 'no')
      const session = yield* startSession({ providerId: 'scripted' }, CONFIG)
      const { env } = (yield* prompted(world, session)).agent.request
      assert.deepStrictEqual([env['BB_PASSED'], env['BB_NOT_NAMED']], ['yes', undefined])
    }),
  )

  suite.effect(
    'starts the agent of a session resumed after a stop without the environment of its creation',
    () =>
      Effect.gen(function* forgetsEnvironment() {
        yield* withEnv('BB_PASSED', 'yes')
        const sessions = yield* SessionManager
        const env = { BYTEBUREAU_EXTRA: '1' }
        const session = yield* startSession({ providerId: 'scripted', env }, CONFIG)
        const first = (yield* prompted(world, session)).agent.request.env
        yield* sessions.stop(session.id)
        yield* sessions.resume(session.id)
        const second = (yield* prompted(world, session, { text: 'again' })).agent.request.env
        assert.deepStrictEqual(
          [
            first['BYTEBUREAU_EXTRA'],
            first['BB_PASSED'],
            second['BYTEBUREAU_EXTRA'],
            second['BB_PASSED'],
          ],
          ['1', 'yes', undefined, undefined],
        )
      }),
  )
})
