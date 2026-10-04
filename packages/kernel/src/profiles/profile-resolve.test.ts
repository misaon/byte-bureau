import { rmSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { EventLog } from '../events/event-log.js'
import { resolved } from '../plugins/plugin-call-fixtures.js'
import { Secrets } from '../secrets/secrets.js'
import { doubtingPlugin } from './failing-fixtures.js'
import { codeOf, loadedProfiles, profileWorld } from './profile-fixtures.js'

const CANARY = 'sk-canary-2'
const KEY_ENV = 'BYTEBUREAU_FAKE_API_KEY'

const resolvesProfiles = Effect.gen(function* resolvesProfiles() {
  const profiles = yield* loadedProfiles
  const none = yield* profiles.resolve('fake', null)
  const keyed = yield* profiles.add({
    providerId: 'fake',
    name: 'key',
    kind: 'api_key',
    apiKey: CANARY,
  })
  const byDefault = yield* profiles.resolve('fake', null)
  assert.deepStrictEqual(none, { ref: { id: 'default', providerId: 'fake', kind: 'login' } })
  assert.deepStrictEqual(byDefault, {
    ref: { id: keyed.id, providerId: 'fake', kind: 'api_key' },
    apiKey: { env: KEY_ENV, value: CANARY },
  })
  const refused = yield* Effect.all([
    codeOf(profiles.resolve('claude', keyed.id)),
    codeOf(profiles.resolve('fake', 'fake/nope')),
  ])
  assert.deepStrictEqual(refused, ['invalid', 'not_found'])
})

const resolvesLogin = Effect.gen(function* resolvesLogin() {
  const profiles = yield* loadedProfiles
  const work = yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  const found = yield* profiles.resolve('fake', work.id)
  assert.deepStrictEqual<unknown>(found, {
    ref: { id: 'fake/work', providerId: 'fake', kind: 'login', configDir: work.configDir },
  })
})

const refusesLostKey = Effect.gen(function* refusesLostKey() {
  const profiles = yield* loadedProfiles
  const secrets = yield* Secrets
  yield* resolved(secrets.delete('@bytebureau/profiles/fake/key/api_key'))
  const named = yield* Effect.flip(profiles.resolve('fake', 'fake/key'))
  assert.deepStrictEqual(
    [named.name, named.message],
    [
      'ProfileError',
      'the key of profile "fake/key" is not in the secret store; remove the profile and add it again',
    ],
  )
  assert.strictEqual(yield* codeOf(profiles.resolve('fake', null)), 'invalid')
})

const resolving = profileWorld()

it.layer(resolving.layer)('ProfileService resolve', (suite) => {
  suite.effect(
    'resolves the explicit profile, else the default, else the nameless login ref, and refuses a mismatch',
    () => resolvesProfiles,
  )
  suite.effect(
    'resolves a login profile to its ref with its directory and no key',
    () => resolvesLogin,
  )
  suite.effect(
    'refuses an api_key profile whose key is no longer in the secret store, by name and as the default',
    () => refusesLostKey,
  )
})

const tellsStatus = Effect.gen(function* tellsStatus() {
  const profiles = yield* loadedProfiles
  const work = yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  const fine = yield* profiles.status(work.id)
  const dir = work.configDir ?? ''
  rmSync(dir, { recursive: true, force: true })
  const gone = yield* profiles.status(work.id)
  assert.deepStrictEqual(
    [fine.state, gone.state, gone.hint],
    ['loggedIn', 'loggedOut', `the directory ${dir} is gone; remove the profile and add it again`],
  )
  const told = yield* EventLog.use((log) => log.read({ types: ['profile.status'] }, { from: 0 }))
  assert.deepStrictEqual(
    told.map((event) => event.payload),
    [
      { profileId: 'fake/work', state: 'loggedIn' },
      { profileId: 'fake/work', state: 'loggedOut' },
    ],
  )
})

const tellsUnknown = Effect.gen(function* tellsUnknown() {
  const profiles = yield* loadedProfiles
  const doubted = yield* profiles.add({ providerId: 'doubting', name: 'd', kind: 'login' })
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO profiles (id, provider_id, name, kind, created_at) VALUES ('ghost/g', 'ghost', 'g', 'login', 't')`
  const failing = yield* profiles.status(doubted.id)
  const unloaded = yield* profiles.status('ghost/g')
  assert.deepStrictEqual(
    [failing.state, failing.hint, unloaded.state, unloaded.hint],
    ['unknown', 'the account check failed', 'unknown', 'provider "ghost" is not loaded'],
  )
  assert.strictEqual(yield* codeOf(profiles.status('fake/nope')), 'not_found')
})

// An api_key profile whose key has left the secret store is logged out, whatever its provider would say
const tellsLostKey = Effect.gen(function* tellsLostKey() {
  const profiles = yield* loadedProfiles
  const keyed = yield* profiles.add({
    providerId: 'fake',
    name: 'key',
    kind: 'api_key',
    apiKey: CANARY,
  })
  const kept = yield* profiles.status(keyed.id)
  yield* resolved((yield* Secrets).delete('@bytebureau/profiles/fake/key/api_key'))
  const lost = yield* profiles.status(keyed.id)
  assert.deepStrictEqual(
    [kept.state, lost.state, lost.hint],
    [
      'loggedIn',
      'loggedOut',
      'the key of profile "fake/key" is not in the secret store; remove the profile and add it again',
    ],
  )
})

const checking = profileWorld([doubtingPlugin])

it.layer(checking.layer)('ProfileService status', (suite) => {
  suite.effect(
    'tells a login profile whose directory is gone as logged out with the hint, and asks the provider otherwise',
    () => tellsStatus,
  )
  suite.effect(
    'tells unknown with the reason when the provider cannot say, or is not loaded, and refuses an id nobody holds',
    () => tellsUnknown,
  )
  suite.effect(
    'tells an api_key profile whose key is gone from the secret store as logged out, without asking its provider',
    () => tellsLostKey,
  )
})
