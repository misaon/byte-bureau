import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ProviderError } from '../errors.js'
import { resolved } from '../plugins/plugin-call-fixtures.js'
import { loadedProfiles } from '../profiles/profile-fixtures.js'
import { Secrets } from '../secrets/secrets.js'
import { sessionOf, startSession } from './session-fixtures.js'
import { SessionManager } from './session-manager.js'
import { prompted } from './session-prompted-fixtures.js'
import { driven } from './session-script-fixtures.js'

const CANARY = 'sk-canary-start'
const KEY_ENV = 'SCRIPTED_API_KEY'
const SCRIPTED = { providerId: 'scripted' } as const
const CONFIG = {
  version: 1,
  project: { name: 'options' },
  employees: {
    developer: {
      name: 'Developer',
      provider: 'scripted',
      model: 'm',
      permissionMode: 'supervised',
    },
  },
  providers: { scripted: { passEnv: ['BB_PASSED'], flavour: 'slow', depth: 2 } },
}

const world = driven({ apiKeyEnv: KEY_ENV })

const handsKey = Effect.gen(function* handsKey() {
  const profiles = yield* loadedProfiles
  yield* profiles.add({ ...SCRIPTED, name: 'key', kind: 'api_key', apiKey: CANARY })
  const session = yield* startSession({ ...SCRIPTED, profileId: 'scripted/key' })
  const { request } = (yield* prompted(world, session)).agent
  assert.deepStrictEqual(
    [request.profile, request.env[KEY_ENV]],
    [{ id: 'scripted/key', providerId: 'scripted', kind: 'api_key' }, CANARY],
  )
})

const handsLogin = Effect.gen(function* handsLogin() {
  const profiles = yield* loadedProfiles
  const work = yield* profiles.add({ ...SCRIPTED, name: 'work', kind: 'login' })
  const session = yield* startSession({ ...SCRIPTED, profileId: work.id })
  const { request } = (yield* prompted(world, session)).agent
  assert.deepStrictEqual(
    [request.profile, request.env[KEY_ENV]],
    [
      { id: 'scripted/work', providerId: 'scripted', kind: 'login', configDir: work.configDir },
      undefined,
    ],
  )
})

const handsOptions = Effect.gen(function* handsOptions() {
  const configured = yield* startSession(SCRIPTED, CONFIG)
  const plain = yield* startSession(SCRIPTED)
  const first = (yield* prompted(world, configured)).agent.request
  const second = (yield* prompted(world, plain)).agent.request
  assert.deepStrictEqual(
    [first.providerConfig, second.providerConfig],
    [{ flavour: 'slow', depth: 2 }, {}],
  )
})

const refusesLostKey = Effect.gen(function* refusesLostKey() {
  const profiles = yield* loadedProfiles
  yield* profiles.add({ ...SCRIPTED, name: 'lost', kind: 'api_key', apiKey: CANARY })
  const session = yield* startSession({ ...SCRIPTED, profileId: 'scripted/lost' })
  yield* resolved((yield* Secrets).delete('@bytebureau/profiles/scripted/lost/api_key'))
  const error = yield* Effect.flip((yield* SessionManager).prompt(session.id, { text: 'go' }))
  assert.ok(error instanceof ProviderError)
  assert.deepStrictEqual(
    [error.kind, error.retryable, error.reason],
    [
      'auth',
      false,
      'the key of profile "scripted/lost" is not in the secret store; add the profile again',
    ],
  )
  assert.strictEqual((yield* sessionOf(session.id)).status, 'ready')
})

it.layer(world.layer)('SessionManager start under a profile', (suite) => {
  suite.effect(
    'hands the agent the ref of its api_key profile and the key in the variable of its provider',
    () => handsKey,
  )
  suite.effect(
    'hands the agent of a login profile its ref with the directory, and no key',
    () => handsLogin,
  )
  suite.effect(
    'hands the agent the providers section of its project without passEnv, and nothing without one',
    () => handsOptions,
  )
  suite.effect(
    'fails the prompt as an auth refusal when the key of its profile is gone, and leaves the session ready',
    () => refusesLostKey,
  )
})
