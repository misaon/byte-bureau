import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { EventLog } from '../events/event-log.js'
import { warnings } from '../plugins/log-fixtures.js'
import { stickySecrets } from './failing-fixtures.js'
import { loadedProfiles, profileWorld } from './profile-fixtures.js'
import type { Profile, ProfileServiceShape } from './profile-service.js'

const KERNEL_KEY = '@bytebureau/profiles/fake/key/api_key'

// The types of the events the log holds
const typesInLog = Effect.map(
  EventLog.use((log) => log.read({}, { from: 0 })),
  (events) => events.map((event) => event.type),
)

// The ids of the profiles that are a default
const defaultsOf = (listed: readonly Profile[]): readonly string[] =>
  listed.filter((profile) => profile.isDefault).map((profile) => profile.id)

// Three login profiles of the fake provider, the first of them its default
const threeOf = (profiles: ProfileServiceShape): ReturnType<ProfileServiceShape['add']> =>
  Effect.andThen(
    Effect.forEach(['a', 'b'], (name) => profiles.add({ providerId: 'fake', name, kind: 'login' })),
    profiles.add({ providerId: 'fake', name: 'c', kind: 'login' }),
  )

const passesInTurn = Effect.gen(function* passesInTurn() {
  const profiles = yield* loadedProfiles
  yield* threeOf(profiles)
  yield* profiles.remove('fake/a')
  const afterFirst = defaultsOf(yield* profiles.list())
  yield* profiles.remove('fake/b')
  const afterSecond = defaultsOf(yield* profiles.list())
  yield* profiles.remove('fake/c')
  const added = yield* profiles.add({ providerId: 'fake', name: 'd', kind: 'login' })
  assert.deepStrictEqual([afterFirst, afterSecond, added.isDefault], [['fake/b'], ['fake/c'], true])
})

const passesAtOnce = Effect.gen(function* passesAtOnce() {
  const profiles = yield* loadedProfiles
  yield* profiles.remove('fake/d')
  yield* threeOf(profiles)
  yield* Effect.all([profiles.remove('fake/a'), profiles.remove('fake/b')], {
    concurrency: 'unbounded',
  })
  assert.deepStrictEqual(defaultsOf(yield* profiles.list()), ['fake/c'])
})

const world = profileWorld()

it.layer(world.layer)('ProfileService defaults', (suite) => {
  suite.effect(
    'passes the default to the oldest profile left at each removal, and to the next one added once none is left',
    () => passesInTurn,
  )
  suite.effect(
    'leaves one default when two profiles of a provider are removed at once',
    () => passesAtOnce,
  )
})

const sticky = profileWorld([], stickySecrets)

const leavesKeyBehind = Effect.gen(function* leavesKeyBehind() {
  const records = yield* warnings
  const profiles = yield* loadedProfiles
  yield* profiles.add({
    providerId: 'fake',
    name: 'key',
    kind: 'api_key',
    apiKey: 'sk-canary-sticky',
  })
  yield* profiles.add({ providerId: 'fake', name: 'work', kind: 'login' })
  yield* profiles.remove('fake/key')
  const listed = yield* profiles.list()
  assert.deepStrictEqual(
    listed.map((profile) => [profile.id, profile.isDefault]),
    [['fake/work', true]],
  )
  assert.deepStrictEqual(
    records.map((record) => [record.message[0], record.properties['key']]),
    [['a removed profile left its key in the secret store', KERNEL_KEY]],
  )
  assert.include(yield* typesInLog, 'profile.removed')
})

it.layer(sticky.layer)('ProfileService over a secret store that cannot delete', (suite) => {
  suite.effect(
    'removes the profile and passes the default all the same, and warns of the key it leaves',
    () => leavesKeyBehind,
  )
})
