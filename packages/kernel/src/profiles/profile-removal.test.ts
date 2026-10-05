import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError } from '../errors.js'
import { resolved } from '../plugins/plugin-call-fixtures.js'
import { Secrets } from '../secrets/secrets.js'
import { UsageService } from '../usage/usage-service.js'
import { loadedProfiles, profileWorld } from './profile-fixtures.js'
import { claimProfile, settleDefault } from './profile-records.js'
import type { Profile } from './profile-service.js'

const KERNEL_KEY = '@bytebureau/profiles/fake/key/api_key'

const defaultsOf = (listed: readonly Profile[]): readonly string[] =>
  listed.filter((profile) => profile.isDefault).map((profile) => profile.id)

const startsAfresh = Effect.gen(function* startsAfresh() {
  const profiles = yield* loadedProfiles
  const usage = yield* UsageService
  yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  yield* usage.record('fake/work', { fiveHourPct: 42 })
  yield* profiles.remove('fake/work')
  yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  assert.strictEqual(yield* usage.snapshot('fake/work'), undefined)
})

// The log refuses every event from now on, as a store that has failed would
const discardsUntold = Effect.gen(function* discardsUntold() {
  const profiles = yield* loadedProfiles
  yield* profiles.add({
    providerId: 'fake',
    name: 'key',
    kind: 'api_key',
    apiKey: 'sk-canary-told',
  })
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TABLE events`
  const failure = yield* Effect.flip(profiles.remove('fake/key'))
  assert.ok(failure instanceof StoreError)
  assert.strictEqual(yield* resolved((yield* Secrets).get(KERNEL_KEY)), undefined)
  assert.deepStrictEqual(yield* profiles.list(), [])
})

it.layer(profileWorld().layer)('ProfileService removal and what it leaves', (suite) => {
  suite.effect(
    'drops the usage snapshots of a removed profile, so one added again starts with none',
    () => startsAfresh,
  )
})

it.layer(profileWorld().layer)('ProfileService removal that cannot be told', (suite) => {
  suite.effect('discards the key of the removed profile all the same', () => discardsUntold)
})

// Two changes of the default that meet: each settles in a transaction of its own
const keepsOneDefault = Effect.gen(function* keepsOneDefault() {
  const profiles = yield* loadedProfiles
  yield* Effect.forEach(['a', 'b'], (name) =>
    profiles.add({ providerId: 'fake', name, kind: 'login' }),
  )
  yield* Effect.all([Effect.exit(profiles.setDefault('fake/a')), profiles.remove('fake/a')], {
    concurrency: 'unbounded',
  })
  const afterMove = defaultsOf(yield* profiles.list())
  yield* Effect.all(
    [profiles.add({ providerId: 'fake', name: 'c', kind: 'login' }), profiles.remove('fake/b')],
    {
      concurrency: 'unbounded',
    },
  )
  assert.deepStrictEqual([afterMove, defaultsOf(yield* profiles.list())], [['fake/b'], ['fake/c']])
})

// A profile removed between its claim and the settling of the default, as a removal that came in between leaves it
const GONE: Profile = {
  id: 'fake/gone',
  providerId: 'fake',
  name: 'gone',
  kind: 'login',
  configDir: null,
  isDefault: false,
  createdAt: '2026-10-05T12:00:00.000Z',
}

const keepsDefaultOfGone = Effect.gen(function* keepsDefaultOfGone() {
  const profiles = yield* loadedProfiles
  yield* Effect.forEach(['a', 'b'], (name) =>
    profiles.add({ providerId: 'fake', name, kind: 'login' }),
  )
  const answered = yield* settleDefault(yield* SqlClient.SqlClient, GONE, true)
  assert.deepStrictEqual([answered, defaultsOf(yield* profiles.list())], [false, ['fake/a']])
})

// A profile claimed while the default of its provider is removed, which passes the default to it before its own settling
const answersPassedDefault = Effect.gen(function* answersPassedDefault() {
  const profiles = yield* loadedProfiles
  const sql = yield* SqlClient.SqlClient
  yield* profiles.add({ providerId: 'fake', name: 'old', kind: 'login' })
  yield* claimProfile(sql, { ...GONE, id: 'fake/new', name: 'new' })
  yield* profiles.remove('fake/old')
  const answered = yield* settleDefault(sql, { ...GONE, id: 'fake/new', name: 'new' }, false)
  assert.deepStrictEqual([answered, defaultsOf(yield* profiles.list())], [true, ['fake/new']])
})

it.layer(profileWorld().layer)(
  'ProfileService default meant for a profile that is gone',
  (suite) => {
    suite.effect(
      'leaves the default of the provider as it is when the profile meant to take it is gone, and answers no default',
      () => keepsDefaultOfGone,
    )
  },
)

it.layer(profileWorld().layer)(
  'ProfileService default passed while a profile is added',
  (suite) => {
    suite.effect(
      'answers the default the profile holds as stored, though it did not ask for it',
      () => answersPassedDefault,
    )
  },
)

it.layer(profileWorld().layer)('ProfileService defaults that meet', (suite) => {
  suite.effect(
    'keeps one default when a removed profile is made the default, and when one is added as the default is removed',
    () => keepsOneDefault,
  )
})
