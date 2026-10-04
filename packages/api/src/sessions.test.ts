import { EventLog, SessionManager } from '@bytebureau/kernel'
import { SessionDto, TurnDto } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { ApiTestLayer, get, post } from './testing.js'
import {
  askedSession,
  createdSession,
  firstEvent,
  recommendedOption,
  registeredProject,
  UNKNOWN_ID,
} from './testing-sessions.js'

it.layer(ApiTestLayer())('POST and GET /api/v1/sessions over the fake provider', (suite) => {
  suite.effect('creates a ready session with its worktree, as the kernel keeps it', () =>
    Effect.gen(function* creates() {
      const { session, status } = yield* createdSession
      assert.strictEqual(status, 201)
      assert.strictEqual(session.status, 'ready')
      assert.containSubset(session.workspace, { runtimeId: 'local', branch: 'bb/create-hello' })
      const record = yield* SessionManager.use((manager) => manager.get(session.id))
      const kept = Schema.encodeSync(SessionDto)(yield* Effect.fromNullishOr(record))
      assert.deepStrictEqual(kept, session)
      const events = yield* EventLog.use((log) => log.read({ sessionId: session.id }, { from: 0 }))
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ['session.created', 'session.provisioning', 'workspace.provisioned', 'session.ready'],
      )
    }),
  )

  suite.effect('lists the sessions and reads one by its id, 404 for an unknown one', () =>
    Effect.gen(function* reads() {
      const { session } = yield* createdSession
      assert.containSubset((yield* get('/sessions')).body, [{ id: session.id }])
      const read = yield* get(`/sessions/${session.id}`)
      assert.deepStrictEqual(read.body, session)
      const missing = yield* get(`/sessions/${UNKNOWN_ID}`)
      assert.strictEqual(missing.status, 404)
      assert.include(missing.type, 'application/problem+json')
      assert.containSubset(missing.body, { code: 'session_not_found' })
    }),
  )
})

it.layer(ApiTestLayer())('POST /api/v1/sessions/:id/prompt over the fake provider', (suite) => {
  suite.effect('prompts a ready session and answers with the turn it began', () =>
    Effect.gen(function* prompts() {
      const { session } = yield* createdSession
      const text = 'Create src/hello.ts exporting hello()'
      const prompted = yield* post(`/sessions/${session.id}/prompt`, { text })
      assert.strictEqual(prompted.status, 200)
      const turn = Schema.decodeUnknownSync(TurnDto)(prompted.body)
      const expected = { sessionId: session.id, index: 0, status: 'running', prompt: { text } }
      assert.containSubset(turn, expected)
    }),
  )

  suite.effect('takes the answer of its question, completes it and reads its usage', () =>
    Effect.gen(function* runsOne() {
      const { session, ask } = yield* askedSession
      const option = yield* recommendedOption(ask)
      const answered = yield* post(`/asks/${ask.id}/answer`, { selected: [option.id] })
      assert.strictEqual(answered.status, 204)
      yield* firstEvent(session.id, 'turn.completed')
      assert.strictEqual((yield* post(`/sessions/${session.id}/complete`)).status, 204)
      assert.containSubset((yield* get(`/sessions/${session.id}`)).body, { status: 'completed' })
      const usage = { turns: 1, inputTokens: 120, outputTokens: 40, costUsd: 0.002, contextPct: 3 }
      assert.deepStrictEqual((yield* get(`/usage/sessions/${session.id}`)).body, usage)
    }),
  )
})

it.layer(ApiTestLayer())('the commands on a session over the fake provider', (suite) => {
  suite.effect('refuses a prompt on a stopped session with 409, an unknown one with 404', () =>
    Effect.gen(function* refuses() {
      const { session } = yield* createdSession
      assert.strictEqual((yield* post(`/sessions/${session.id}/stop`)).status, 204)
      const prompted = yield* post(`/sessions/${session.id}/prompt`, { text: 'x' })
      assert.strictEqual(prompted.status, 409)
      assert.containSubset(prompted.body, { code: 'session_invalid_transition' })
      const missing = yield* post(`/sessions/${UNKNOWN_ID}/stop`)
      assert.strictEqual(missing.status, 404)
      assert.containSubset(missing.body, { code: 'session_not_found' })
    }),
  )

  suite.effect('stops a session, resumes it and refuses to resume one that is ready', () =>
    Effect.gen(function* stopsAndResumes() {
      const { session } = yield* createdSession
      yield* post(`/sessions/${session.id}/stop`)
      assert.containSubset((yield* get(`/sessions/${session.id}`)).body, { status: 'stopped' })
      const resumed = yield* post(`/sessions/${session.id}/resume`)
      assert.strictEqual(resumed.status, 200)
      assert.containSubset(resumed.body, { id: session.id, status: 'ready' })
      const again = yield* post(`/sessions/${session.id}/resume`)
      assert.strictEqual(again.status, 409)
      assert.containSubset(again.body, { code: 'session_invalid_transition' })
    }),
  )

  suite.effect('interrupts a turn that is running, and the session is ready again', () =>
    Effect.gen(function* interrupts() {
      const { project } = yield* registeredProject
      const env = { BYTEBUREAU_FAKE_SCRIPT: 'slow' }
      const created = yield* post('/sessions', { projectId: project.id, title: 'Slow', env })
      const { id } = Schema.decodeUnknownSync(SessionDto)(created.body)
      yield* post(`/sessions/${id}/prompt`, { text: 'go' })
      yield* firstEvent(id, 'turn.started')
      assert.strictEqual((yield* post(`/sessions/${id}/interrupt`)).status, 204)
      yield* firstEvent(id, 'turn.interrupted')
      assert.containSubset((yield* get(`/sessions/${id}`)).body, { status: 'ready' })
      assert.strictEqual((yield* post(`/sessions/${id}/complete`)).status, 204)
    }),
  )
})

it.layer(ApiTestLayer())('POST /api/v1/sessions/:id/interrupt without a turn at work', (suite) => {
  suite.effect(
    'refuses to interrupt a session with no turn at work with 409, an unknown one with 404',
    () =>
      Effect.gen(function* refusesInterrupt() {
        const { session } = yield* createdSession
        const idle = yield* post(`/sessions/${session.id}/interrupt`)
        const missing = yield* post(`/sessions/${UNKNOWN_ID}/interrupt`)
        assert.deepStrictEqual([idle.status, missing.status], [409, 404])
        assert.containSubset(idle.body, {
          code: 'session_invalid_transition',
          detail: 'cannot interrupt a ready session: no turn of it is at work',
        })
        assert.containSubset(missing.body, { code: 'session_not_found' })
      }),
  )

  suite.effect('refuses with 409 a session whose turn has ended, its agent still attached', () =>
    Effect.gen(function* refusesBetweenTurns() {
      const { session, ask } = yield* askedSession
      const answer = { selected: [(yield* recommendedOption(ask)).id] }
      assert.strictEqual((yield* post(`/asks/${ask.id}/answer`, answer)).status, 204)
      // The end of the turn is told once the session is ready again, its agent kept for the next prompt
      yield* firstEvent(session.id, 'turn.completed')
      const idle = yield* post(`/sessions/${session.id}/interrupt`)
      assert.strictEqual(idle.status, 409)
      assert.containSubset(idle.body, {
        code: 'session_invalid_transition',
        detail: 'cannot interrupt a ready session: no turn of it is at work',
      })
    }),
  )
})

it.layer(ApiTestLayer())('GET /api/v1/usage/sessions/:id over the fake provider', (suite) => {
  suite.effect('answers 404 for the usage of a session that is not there', () =>
    Effect.gen(function* refusesUnknown() {
      const missing = yield* get(`/usage/sessions/${UNKNOWN_ID}`)
      assert.strictEqual(missing.status, 404)
      assert.containSubset(missing.body, { code: 'session_not_found' })
    }),
  )

  suite.effect('reads no usage of a session that has had no turn, the costs as null', () =>
    Effect.gen(function* readsNothing() {
      const { session } = yield* createdSession
      const usage = yield* get(`/usage/sessions/${session.id}`)
      assert.strictEqual(usage.status, 200)
      const none = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: null, contextPct: null }
      assert.deepStrictEqual(usage.body, none)
    }),
  )
})

// A profile of a provider no plugin offers any more, which the store keeps
const foreignProfile = Effect.gen(function* keepsProfile() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO profiles (id, provider_id, name, kind, config_dir, is_default, created_at)
    VALUES ('other/work', 'other', 'work', 'login', NULL, 0, ${new Date().toISOString()})`
})

it.layer(ApiTestLayer())('POST /api/v1/sessions under a profile', (suite) => {
  suite.effect('refuses a profile nobody holds with 404, and creates nothing', () =>
    Effect.gen(function* refusesUnknown() {
      const { project } = yield* registeredProject
      const body = { projectId: project.id, title: 'x', profileId: 'fake/nope' }
      const refused = yield* post('/sessions', body)
      assert.strictEqual(refused.status, 404)
      assert.include(refused.type, 'application/problem+json')
      assert.containSubset(refused.body, {
        code: 'profile_not_found',
        detail: 'no profile "fake/nope"',
      })
      assert.notInclude(JSON.stringify((yield* get('/sessions')).body), project.id)
    }),
  )

  suite.effect('refuses the profile of another provider with 422, and creates nothing', () =>
    Effect.gen(function* refusesForeign() {
      yield* foreignProfile
      const { project } = yield* registeredProject
      const body = { projectId: project.id, title: 'x', profileId: 'other/work' }
      const refused = yield* post('/sessions', body)
      assert.strictEqual(refused.status, 422)
      assert.include(refused.type, 'application/problem+json')
      assert.containSubset(refused.body, {
        code: 'profile_invalid',
        detail: 'profile "other/work" belongs to provider "other", not "fake"',
      })
      assert.notInclude(JSON.stringify((yield* get('/sessions')).body), project.id)
    }),
  )
})
