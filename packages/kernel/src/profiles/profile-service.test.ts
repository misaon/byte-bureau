import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { EventLog } from '../events/event-log.js'
import { resolved } from '../plugins/plugin-call-fixtures.js'
import { probe } from '../plugins/plugin-fixtures.js'
import { Secrets } from '../secrets/secrets.js'
import { doubtingPlugin, refusingSecrets } from './failing-fixtures.js'
import { codeOf, loadedProfiles, profileWorld } from './profile-fixtures.js'

const world = profileWorld([doubtingPlugin])
const CANARY = 'sk-canary-1'
const KERNEL_KEY = '@bytebureau/profiles/fake/key/api_key'

const modeOf = (file: string): number => statSync(file).mode % 0o1000

const workDir = (): string => path.join(world.home, 'profiles', 'fake', 'work')

// Everything the log holds, as one text a secret must not appear in
const logText = Effect.map(
  EventLog.use((log) => log.read({}, { from: 0 })),
  (events) => JSON.stringify(events),
)

const addsLoginProfile = Effect.gen(function* addsLoginProfile() {
  const profiles = yield* loadedProfiles
  const added = yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  assert.deepStrictEqual(
    [added.id, added.isDefault, added.configDir],
    ['fake/work', true, workDir()],
  )
  assert.strictEqual(modeOf(workDir()), 0o700)
  const listed = yield* profiles.list()
  assert.deepStrictEqual(
    listed.map((profile) => profile.id),
    ['fake/work'],
  )
  assert.include(yield* logText, '"type":"profile.added"')
})

const keepsKey = Effect.gen(function* keepsKey() {
  const profiles = yield* loadedProfiles
  const keyed = yield* profiles.add({
    providerId: 'fake',
    name: 'key',
    kind: 'api_key',
    apiKey: CANARY,
  })
  const secrets = yield* Secrets
  assert.deepStrictEqual([keyed.configDir, keyed.isDefault], [null, false])
  assert.strictEqual(yield* resolved(secrets.get(KERNEL_KEY)), CANARY)
  assert.notInclude(JSON.stringify(yield* profiles.list()), CANARY)
  assert.notInclude(yield* logText, CANARY)
})

const refusesProfiles = Effect.gen(function* refusesProfiles() {
  const profiles = yield* loadedProfiles
  const refused = yield* Effect.all([
    codeOf(profiles.add({ providerId: 'fake', name: 'key', kind: 'api_key', apiKey: 'x' })),
    codeOf(profiles.add({ providerId: 'fake', name: 'l', kind: 'login', apiKey: 'x' })),
    codeOf(profiles.add({ providerId: 'fake', name: 'n', kind: 'api_key' })),
    codeOf(profiles.add({ providerId: 'fake', name: 'e', kind: 'api_key', apiKey: '' })),
    codeOf(profiles.add({ providerId: 'doubting', name: 'd', kind: 'api_key', apiKey: 'x' })),
    codeOf(profiles.add({ providerId: 'fake', name: 'Not/Ok', kind: 'login' })),
    codeOf(profiles.add({ providerId: 'ghost', name: 'g', kind: 'login' })),
  ])
  assert.deepStrictEqual(refused, [
    'exists',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'invalid',
    'SessionError',
  ])
  assert.strictEqual((yield* profiles.list()).length, 2)
  assert.isFalse(existsSync(path.join(world.home, 'profiles', 'fake', 'l')))
})

const movesDefault = Effect.gen(function* movesDefault() {
  const profiles = yield* loadedProfiles
  yield* profiles.setDefault('fake/key')
  const listed = yield* profiles.list()
  assert.deepStrictEqual(
    listed.map((profile) => [profile.id, profile.isDefault]),
    [
      ['fake/work', false],
      ['fake/key', true],
    ],
  )
  assert.strictEqual(yield* codeOf(profiles.setDefault('fake/nope')), 'not_found')
})

const removesProfile = Effect.gen(function* removesProfile() {
  const profiles = yield* loadedProfiles
  yield* profiles.remove('fake/key')
  const secrets = yield* Secrets
  assert.isUndefined(yield* resolved(secrets.get(KERNEL_KEY)))
  const listed = yield* profiles.list()
  assert.deepStrictEqual(
    listed.map((profile) => [profile.id, profile.isDefault]),
    [['fake/work', true]],
  )
  assert.include(yield* logText, '"type":"profile.removed"')
})

const purgesDirectory = Effect.gen(function* purgesDirectory() {
  const profiles = yield* loadedProfiles
  yield* profiles.remove('fake/work')
  assert.isTrue(existsSync(workDir()))
  const again = yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  yield* profiles.remove(again.id, { purge: true })
  assert.isFalse(existsSync(workDir()))
  assert.strictEqual(yield* codeOf(profiles.remove('fake/work')), 'not_found')
  assert.deepStrictEqual(yield* profiles.list(), [])
})

it.layer(world.layer)('ProfileService', (suite) => {
  suite.effect(
    'adds a login profile with its own directory, makes the first one the default and lists it',
    () => addsLoginProfile,
  )
  suite.effect(
    'keeps an API key in the secret store only, under a key no plugin can name',
    () => keepsKey,
  )
  suite.effect(
    'refuses a name twice, a key for a login profile, an api_key profile without a key or for a provider that takes none, a bad name and an unknown provider',
    () => refusesProfiles,
  )
  suite.effect('moves the default to the profile that is made the default', () => movesDefault)
  suite.effect(
    'removes a profile with its key and passes the default to the oldest one left',
    () => removesProfile,
  )
  suite.effect(
    'keeps the directory of a removed login profile unless it is purged, and refuses an id nobody holds',
    () => purgesDirectory,
  )
})

const named = probe('profiles')
const shared = profileWorld([named.plugin])

it.layer(shared.layer)('ProfileService beside a plugin named profiles', (suite) => {
  suite.effect('keeps the key of a profile out of the reach of the secrets of that plugin', () =>
    Effect.gen(function* keepsKeyApart() {
      const profiles = yield* loadedProfiles
      yield* profiles.add({ providerId: 'fake', name: 'key', kind: 'api_key', apiKey: CANARY })
      const { secrets } = named.context()
      assert.isUndefined(yield* resolved(secrets.get('fake/key/api_key')))
      yield* resolved(secrets.set('fake/key/api_key', 'planted'))
      const found = yield* profiles.resolve('fake', 'fake/key')
      assert.deepStrictEqual(found.apiKey, { env: 'BYTEBUREAU_FAKE_API_KEY', value: CANARY })
    }),
  )
})

const locked = profileWorld([], refusingSecrets)

it.layer(locked.layer)('ProfileService over a secret store that refuses the key', (suite) => {
  suite.effect('fails as the store and keeps nothing of the profile', () =>
    Effect.gen(function* keepsNothing() {
      const profiles = yield* loadedProfiles
      const input = { providerId: 'fake', name: 'key', kind: 'api_key', apiKey: CANARY } as const
      const failure = yield* Effect.flip(profiles.add(input))
      assert.deepStrictEqual(
        [failure.name, failure.message],
        ['StoreError', 'the keychain is locked'],
      )
      assert.deepStrictEqual(yield* profiles.list(), [])
      assert.notInclude(yield* logText, 'profile.added')
      assert.deepStrictEqual(yield* profiles.resolve('fake', null), {
        ref: { id: 'default', providerId: 'fake', kind: 'login' },
      })
    }),
  )
})
