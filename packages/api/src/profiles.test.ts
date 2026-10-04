import { existsSync } from 'node:fs'
import { UsageService } from '@bytebureau/kernel'
import { ProfileDto, SessionDto, UsageSnapshotDto } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Schema, type Cause } from 'effect'
import type { HttpServer } from 'effect/http'
import { ApiTestLayer, get, post, remove, type Reply } from './testing.js'
import { registeredProject } from './testing-sessions.js'

// A key no answer, problem or listing may repeat
const CANARY = 'sk-canary-api'

const LOGIN = { providerId: 'fake', name: 'work', kind: 'login' } as const
const KEYED = { providerId: 'fake', name: 'key', kind: 'api_key', apiKey: CANARY } as const

const profilesOf = (reply: Reply): readonly ProfileDto[] =>
  Schema.decodeUnknownSync(Schema.Array(ProfileDto))(reply.body)

// Which profile is the default of its provider, in the order the API lists them
const defaultsOf = (reply: Reply): [string, boolean][] =>
  profilesOf(reply).map((profile) => [profile.id, profile.isDefault])

// The profiles added through the API in turn, each of which has to be created
const added = (...bodies: readonly object[]): Effect.Effect<void, never, HttpServer.HttpServer> =>
  Effect.gen(function* addsAll() {
    for (const body of bodies) {
      const created = yield* post('/profiles', body)
      assert.strictEqual(created.status, 201, JSON.stringify(created.body))
    }
  })

// The login directory of a profile of a listing
const directoryOf = (listed: Reply, id: string): Effect.Effect<string, Cause.NoSuchElementError> =>
  Effect.fromNullishOr(profilesOf(listed).find((profile) => profile.id === id)).pipe(
    Effect.flatMap((profile) => Effect.fromNullishOr(profile.configDir)),
  )

// A session of the fake provider created under the profile
const sessionUnder = (profileId: string): Effect.Effect<SessionDto, never, HttpServer.HttpServer> =>
  Effect.gen(function* creates() {
    const { project } = yield* registeredProject
    const body = { projectId: project.id, title: 'Under a profile', profileId }
    const created = yield* post('/sessions', body)
    assert.strictEqual(created.status, 201, JSON.stringify(created.body))
    return Schema.decodeUnknownSync(SessionDto)(created.body)
  })

interface Refusal {
  readonly title: string
  readonly body: Record<string, unknown>
  readonly status: number
  readonly code: string
}

// What the profiles of the API refuse to add, with the status and the code each is told with
const REFUSALS: Refusal[] = [
  { title: 'a duplicate', body: LOGIN, status: 409, code: 'profile_exists' },
  {
    title: 'a key for a login profile',
    body: { ...LOGIN, name: 'l', apiKey: CANARY },
    status: 422,
    code: 'profile_invalid',
  },
  {
    title: 'an API-key profile with an empty key',
    body: { ...KEYED, name: 'e', apiKey: '' },
    status: 422,
    code: 'profile_invalid',
  },
  {
    title: 'a provider nobody offers',
    body: { providerId: 'ghost', name: 'g', kind: 'login' },
    status: 422,
    code: 'session_provider_missing',
  },
  {
    title: 'a name that is no profile name, with a key',
    body: { ...KEYED, name: 'Not A Name' },
    status: 400,
    code: 'request_invalid',
  },
  {
    title: 'a kind that is no kind, with a key',
    body: { ...KEYED, name: 'k', kind: 'oauth' },
    status: 400,
    code: 'request_invalid',
  },
]

it.layer(ApiTestLayer())('POST and GET /api/v1/profiles', (suite) => {
  suite.effect(
    'adds a login and an API-key profile, lists them in the order they were added, and never echoes a key',
    () =>
      Effect.gen(function* adds() {
        const login = yield* post('/profiles', LOGIN)
        assert.include(login.type, 'application/json')
        const created = { id: 'fake/work', kind: 'login', isDefault: true }
        assert.containSubset(login, { status: 201, body: created })
        const keyed = yield* post('/profiles', KEYED)
        const expected = { id: 'fake/key', kind: 'api_key', configDir: null, isDefault: false }
        assert.containSubset(keyed, { status: 201, body: expected })
        const listed = yield* get('/profiles')
        assert.deepStrictEqual(defaultsOf(listed), [
          ['fake/work', true],
          ['fake/key', false],
        ])
        assert.notInclude(JSON.stringify([keyed.body, listed.body]), CANARY)
      }),
  )
})

it.layer(ApiTestLayer())('the refusals of POST /api/v1/profiles', (suite) => {
  suite.effect.each(REFUSALS)('refuses $title with $status $code and keeps nothing', (refusal) =>
    Effect.gen(function* refuses() {
      yield* post('/profiles', LOGIN)
      const refused = yield* post('/profiles', refusal.body)
      assert.strictEqual(refused.status, refusal.status)
      assert.include(refused.type, 'application/problem+json')
      assert.containSubset(refused.body, { code: refusal.code })
      assert.notInclude(JSON.stringify(refused.body), CANARY)
      const listed = yield* get('/profiles')
      assert.deepStrictEqual(defaultsOf(listed), [['fake/work', true]])
    }),
  )
})

it.layer(ApiTestLayer())('POST /api/v1/profiles/:id/default', (suite) => {
  suite.effect('moves the default of the provider to a profile named by its encoded id', () =>
    Effect.gen(function* movesDefault() {
      yield* added(LOGIN, KEYED)
      const moved = yield* post('/profiles/fake%2Fkey/default')
      assert.strictEqual(moved.status, 204)
      assert.deepStrictEqual(defaultsOf(yield* get('/profiles')), [
        ['fake/work', false],
        ['fake/key', true],
      ])
    }),
  )
})

it.layer(ApiTestLayer())('GET /api/v1/profiles/:id/status', (suite) => {
  suite.effect('tells the status of a login profile and of an API-key profile', () =>
    Effect.gen(function* tellsStatus() {
      yield* added(LOGIN, KEYED)
      const login = yield* get('/profiles/fake%2Fwork/status')
      assert.strictEqual(login.status, 200)
      assert.containSubset(login.body, { profileId: 'fake/work', state: 'loggedIn' })
      const keyed = yield* get('/profiles/fake%2Fkey/status')
      assert.containSubset(keyed.body, { profileId: 'fake/key', state: 'loggedIn' })
      assert.notInclude(JSON.stringify([login.body, keyed.body]), CANARY)
    }),
  )
})

it.layer(ApiTestLayer())('the endpoints of a profile nobody holds', (suite) => {
  suite.effect('answer 404 profile_not_found, whatever is asked of the profile', () =>
    Effect.gen(function* refusesUnknown() {
      const replies = yield* Effect.all([
        post('/profiles/fake%2Fnope/default'),
        get('/profiles/fake%2Fnope/status'),
        remove('/profiles/fake%2Fnope'),
      ])
      assert.deepStrictEqual(
        replies.map((reply) => reply.status),
        [404, 404, 404],
      )
      const decoded = { code: 'profile_not_found', detail: 'no profile "fake/nope"' }
      for (const reply of replies) {
        assert.include(reply.type, 'application/problem+json')
        assert.containSubset(reply.body, decoded)
      }
      const acp = yield* get('/profiles/acp%3Agemini%2Fwork/status')
      assert.containSubset(acp.body, { detail: 'no profile "acp:gemini/work"' })
    }),
  )
})

it.layer(ApiTestLayer())('DELETE /api/v1/profiles/:id', (suite) => {
  suite.effect('removes a profile no session runs under, and the default passes to the next', () =>
    Effect.gen(function* removes() {
      yield* added(LOGIN, KEYED)
      assert.strictEqual((yield* remove('/profiles/fake%2Fwork')).status, 204)
      assert.deepStrictEqual(defaultsOf(yield* get('/profiles')), [['fake/key', true]])
      const gone = yield* get('/profiles/fake%2Fwork/status')
      assert.strictEqual(gone.status, 404)
      assert.containSubset(gone.body, { code: 'profile_not_found' })
    }),
  )
})

it.layer(ApiTestLayer())('DELETE /api/v1/profiles/:id with a purge', (suite) => {
  suite.effect('takes the login directory of a profile only when asked to purge it', () =>
    Effect.gen(function* purges() {
      yield* added({ ...LOGIN, name: 'kept' }, { ...LOGIN, name: 'purged' })
      const listed = yield* get('/profiles')
      const kept = yield* directoryOf(listed, 'fake/kept')
      const purged = yield* directoryOf(listed, 'fake/purged')
      assert.deepStrictEqual([existsSync(kept), existsSync(purged)], [true, true])
      assert.strictEqual((yield* remove('/profiles/fake%2Fkept?purge=false')).status, 204)
      assert.strictEqual((yield* remove('/profiles/fake%2Fpurged?purge=true')).status, 204)
      assert.deepStrictEqual([existsSync(kept), existsSync(purged)], [true, false])
    }),
  )

  suite.effect('refuses a purge that is neither true nor false with 400, and removes nothing', () =>
    Effect.gen(function* refusesPurge() {
      yield* added({ ...LOGIN, name: 'stays' })
      const refused = yield* remove('/profiles/fake%2Fstays?purge=maybe')
      assert.strictEqual(refused.status, 400)
      assert.containSubset(refused.body, { code: 'request_invalid' })
      const listed = yield* get('/profiles')
      assert.include(
        profilesOf(listed).map((profile) => profile.id),
        'fake/stays',
      )
    }),
  )
})

it.layer(ApiTestLayer())('DELETE /api/v1/profiles/:id under a session', (suite) => {
  suite.effect('refuses to remove the profile of a session that has not ended, with 409', () =>
    Effect.gen(function* refusesBusy() {
      yield* added(LOGIN)
      const session = yield* sessionUnder('fake/work')
      assert.strictEqual(session.profileId, 'fake/work')
      const busy = yield* remove('/profiles/fake%2Fwork')
      assert.strictEqual(busy.status, 409)
      assert.containSubset(busy.body, { code: 'profile_in_use' })
      assert.strictEqual((yield* post(`/sessions/${session.id}/complete`)).status, 204)
      assert.strictEqual((yield* remove('/profiles/fake%2Fwork')).status, 204)
      const ended = yield* get(`/sessions/${session.id}`)
      assert.containSubset(ended.body, { status: 'completed', profileId: null })
    }),
  )
})

const SEEN = { fiveHourPct: 80, sevenDayPct: 12 }

it.layer(ApiTestLayer())('GET /api/v1/usage/profiles/:id', (suite) => {
  suite.effect(
    'answers an empty snapshot before any rate limit was seen, and 404 for an unknown profile',
    () =>
      Effect.gen(function* readsEmpty() {
        yield* added(LOGIN)
        const empty = yield* get('/usage/profiles/fake%2Fwork')
        assert.strictEqual(empty.status, 200)
        assert.deepStrictEqual(empty.body, {
          profileId: 'fake/work',
          rateLimit: {},
          observedAt: null,
        })
        const missing = yield* get('/usage/profiles/fake%2Fnope')
        assert.strictEqual(missing.status, 404)
        assert.containSubset(missing.body, { code: 'profile_not_found' })
      }),
  )

  suite.effect('answers the newest rate limit the kernel recorded under the profile', () =>
    Effect.gen(function* readsRecorded() {
      yield* added({ ...LOGIN, name: 'seen' })
      yield* UsageService.use((usage) => usage.record('fake/seen', { fiveHourPct: 40 }))
      yield* UsageService.use((usage) => usage.record('fake/seen', SEEN))
      const snapshot = yield* get('/usage/profiles/fake%2Fseen')
      const decoded = Schema.decodeUnknownSync(UsageSnapshotDto)(snapshot.body)
      assert.deepStrictEqual([decoded.profileId, decoded.rateLimit], ['fake/seen', SEEN])
      assert.isString(decoded.observedAt)
    }),
  )
})
