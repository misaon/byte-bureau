import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, get, TEST_TOKEN } from './testing.js'
import { called, connected, refusedWith, SUCCEEDED, type WsMessage } from './testing-ws.js'

const LOGIN = { providerId: 'fake', name: 'work', kind: 'login' }

// A key no answer of a procedure may repeat
const CANARY = 'sk-canary-rpc'

const answeredWith = (value: object): object => ({ exit: { _tag: 'Success', value } })

// A payload the schema refuses fails the request; what it fails with is not the point, only that it holds no key
const FAILED = { exit: { _tag: 'Failure' } }

const NAMELESS = { profileId: 'default', rateLimit: {}, observedAt: null }

// The profile procedures in an order the kernel accepts, and what each answers; a procedure without a payload takes null, as effect/rpc encodes void
const PROFILE_CALLS: [string, unknown, object][] = [
  ['profiles.add', LOGIN, answeredWith({ id: 'fake/work', kind: 'login', isDefault: true })],
  ['profiles.add', { ...LOGIN, name: 'l', apiKey: CANARY }, refusedWith('profile_invalid')],
  ['profiles.add', { ...LOGIN, name: 'Not A Name', apiKey: CANARY }, FAILED],
  ['profiles.list', null, answeredWith([{ id: 'fake/work' }])],
  ['profiles.status', { id: 'fake/work' }, answeredWith({ state: 'loggedIn' })],
  ['usage.profile', { id: 'fake/work' }, answeredWith({ rateLimit: {}, observedAt: null })],
  ['usage.profile', { id: 'default' }, answeredWith(NAMELESS)],
  ['usage.profile', { id: 'fake/nope' }, refusedWith('profile_not_found')],
  ['profiles.setDefault', { id: 'fake/work' }, SUCCEEDED],
  ['profiles.remove', { id: 'fake/work', purge: true }, SUCCEEDED],
  ['profiles.status', { id: 'fake/work' }, refusedWith('profile_not_found')],
]

it.layer(ApiTestLayer())('the profile procedures over the WebSocket of /api/v1/ws', (suite) => {
  suite.effect('reaches every profile procedure on it, and fails one with its problem', () =>
    Effect.gen(function* drivesProfiles() {
      const client = yield* connected()
      const exits: WsMessage[] = []
      for (const [index, [tag, payload, answer]] of PROFILE_CALLS.entries()) {
        const id = String(index)
        const done = yield* called(client, { id, tag, payload, token: TEST_TOKEN })
        assert.containSubset(done, { requestId: id, ...answer })
        exits.push(done)
      }
      assert.notInclude(JSON.stringify(exits), CANARY)
      assert.deepStrictEqual((yield* get('/profiles')).body, [])
    }),
  )
})
