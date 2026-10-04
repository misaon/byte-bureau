import { ApiError, createBureauClient, type BureauClient } from '@bytebureau/client'
import type { EventLog } from '@bytebureau/kernel'
import { createTempRepo, writeConfig } from '@bytebureau/kernel/testing'
import type { AskRecord, ProjectDto, SessionDto } from '@bytebureau/protocol'
import { assert, it } from '@effect/vitest'
import { Effect, type Cause } from 'effect'
import { ApiTestLayer, baseUrl, TEST_TOKEN } from './testing.js'
import { awaited, client, refused } from './testing-client.js'
import { fakeProjectConfig, firstEvent, recommendedOption, UNKNOWN_ID } from './testing-sessions.js'

interface Created {
  readonly project: ProjectDto
  readonly session: SessionDto
}

// A session of a fresh project, both made through the client
const createdWith = (api: BureauClient): Effect.Effect<Created> =>
  Effect.gen(function* creates() {
    const repo = createTempRepo()
    writeConfig(repo, fakeProjectConfig)
    const project = yield* awaited(api.projects.register({ path: repo }))
    const session = yield* awaited(
      api.sessions.create({ projectId: project.id, title: 'Create hello' }),
    )
    return { project, session }
  })

const HELLO = {
  text: 'Create src/hello.ts exporting hello()',
  attachments: [{ path: 'README.md' }],
}

// The question of the first turn of a session, as the client reads it
const askedWith = (
  api: BureauClient,
  sessionId: string,
): Effect.Effect<AskRecord, Cause.NoSuchElementError, EventLog> =>
  Effect.gen(function* asks() {
    const turn = yield* awaited(api.sessions.prompt(sessionId, HELLO))
    assert.containSubset(turn, { sessionId, index: 0, prompt: HELLO })
    yield* firstEvent(sessionId, 'ask.requested').pipe(Effect.orDie)
    const [ask] = yield* awaited(api.asks.pending(sessionId))
    return yield* Effect.fromNullishOr(ask)
  })

it.layer(ApiTestLayer())('the projects and the daemon through @bytebureau/client', (suite) => {
  suite.effect(
    'registers, lists, reads and removes a project; an unknown one reads as undefined',
    () =>
      Effect.gen(function* projects() {
        const api = yield* client
        const repo = createTempRepo()
        writeConfig(repo, fakeProjectConfig)
        const project = yield* awaited(api.projects.register({ path: repo }))
        assert.containSubset(yield* awaited(api.projects.list()), [{ id: project.id, path: repo }])
        assert.deepStrictEqual(yield* awaited(api.projects.get(project.id)), project)
        assert.isUndefined(yield* awaited(api.projects.get(UNKNOWN_ID)))
        yield* awaited(api.projects.remove(project.id))
        assert.isUndefined(yield* awaited(api.projects.get(project.id)))
      }),
  )

  suite.effect('lists the plugins and the providers and checks the health', () =>
    Effect.gen(function* daemon() {
      const api = yield* client
      const plugins = yield* awaited(api.plugins.list())
      assert.deepStrictEqual(
        plugins.map((plugin) => plugin.state),
        ['loaded', 'loaded'],
      )
      assert.containSubset(yield* awaited(api.plugins.providers()), [{ id: 'fake' }])
      const health = yield* awaited(api.health.check())
      assert.containSubset(health, { status: 'ok', version: '0.0.0-test' })
    }),
  )
})

it.layer(ApiTestLayer())('the asks of the API through @bytebureau/client', (suite) => {
  suite.effect('lists the pending questions of one session, or of every session', () =>
    Effect.gen(function* pending() {
      const api = yield* client
      const first = yield* createdWith(api)
      const second = yield* createdWith(api)
      const ask = yield* askedWith(api, first.session.id)
      const other = yield* askedWith(api, second.session.id)
      const ofFirst = yield* awaited(api.asks.pending(first.session.id))
      assert.deepStrictEqual(
        ofFirst.map((waiting) => waiting.id),
        [ask.id],
      )
      const all = yield* awaited(api.asks.pending())
      assert.includeMembers(
        all.map((waiting) => waiting.id),
        [ask.id, other.id],
      )
    }),
  )

  suite.effect('reads the question of a session pending, answers it and reads it answered', () =>
    Effect.gen(function* answers() {
      const api = yield* client
      const { session } = yield* createdWith(api)
      const ask = yield* askedWith(api, session.id)
      assert.containSubset(yield* awaited(api.asks.get(ask.id)), { status: 'pending' })
      const option = yield* recommendedOption(ask)
      yield* awaited(api.asks.answer(ask.id, { selected: [option.id] }))
      const answered = { status: 'answered', answeredVia: 'api', answer: { selected: [option.id] } }
      assert.containSubset(yield* awaited(api.asks.get(ask.id)), answered)
      assert.isUndefined(yield* awaited(api.asks.get(UNKNOWN_ID)))
    }),
  )
})

it.layer(ApiTestLayer())('the sessions of the API through @bytebureau/client', (suite) => {
  suite.effect('completes a session whose turn is done, and reads it, its usage and the list', () =>
    Effect.gen(function* completes() {
      const api = yield* client
      const { session } = yield* createdWith(api)
      const ask = yield* askedWith(api, session.id)
      yield* awaited(api.asks.answer(ask.id, { selected: 'other', otherText: 'a default export' }))
      yield* firstEvent(session.id, 'turn.completed')
      yield* awaited(api.sessions.complete(session.id))
      assert.containSubset(yield* awaited(api.sessions.get(session.id)), { status: 'completed' })
      const usage = { turns: 1, inputTokens: 120, outputTokens: 40, costUsd: 0.002, contextPct: 3 }
      assert.deepStrictEqual(yield* awaited(api.usage.session(session.id)), usage)
      assert.containSubset(yield* awaited(api.sessions.list()), [{ id: session.id }])
    }),
  )

  suite.effect('stops and resumes a session; an interrupt without an agent is refused', () =>
    Effect.gen(function* stops() {
      const api = yield* client
      const { session } = yield* createdWith(api)
      const idle = { status: 409, problem: { code: 'session_invalid_transition' } }
      assert.containSubset(yield* refused(api.sessions.interrupt(session.id)), idle)
      yield* awaited(api.sessions.stop(session.id))
      assert.containSubset(yield* awaited(api.sessions.get(session.id)), { status: 'stopped' })
      const resumed = yield* awaited(api.sessions.resume(session.id))
      assert.containSubset(resumed, { id: session.id, status: 'ready' })
      assert.isUndefined(yield* awaited(api.sessions.get(UNKNOWN_ID)))
    }),
  )
})

it.layer(ApiTestLayer())('the worktrees of the API through @bytebureau/client', (suite) => {
  suite.effect('lists the worktrees of one project, or of every project', () =>
    Effect.gen(function* lists() {
      const api = yield* client
      const { project, session } = yield* createdWith(api)
      const elsewhere = yield* createdWith(api)
      const ofProject = yield* awaited(api.workspaces.list(project.id))
      assert.containSubset(ofProject, [{ sessionId: session.id, projectId: project.id }])
      assert.deepStrictEqual(
        ofProject.map((info) => info.sessionId),
        [session.id],
      )
      const all = yield* awaited(api.workspaces.list())
      assert.includeMembers(
        all.map((info) => info.sessionId),
        [session.id, elsewhere.session.id],
      )
    }),
  )

  suite.effect('prunes the worktrees of one project, or of every project', () =>
    Effect.gen(function* prunes() {
      const api = yield* client
      const { project, session } = yield* createdWith(api)
      const elsewhere = yield* createdWith(api)
      const here = yield* Effect.fromNullishOr(session.workspace)
      const there = yield* Effect.fromNullishOr(elsewhere.session.workspace)
      const pruned = yield* awaited(api.workspaces.prune(project.id))
      assert.deepStrictEqual(pruned, {
        removed: [],
        retained: [{ path: here.path, reason: 'session is ready' }],
      })
      const all = yield* awaited(api.workspaces.prune())
      assert.includeMembers(
        all.retained.map((kept) => kept.path),
        [here.path, there.path],
      )
    }),
  )
})

it.layer(ApiTestLayer())('the refusals @bytebureau/client throws', (suite) => {
  suite.effect('throws a problem as an ApiError: an unknown session, a wrong token', () =>
    Effect.gen(function* refuses() {
      const api = yield* client
      const unknown = yield* refused(api.sessions.prompt(UNKNOWN_ID, { text: 'x' }))
      assert.instanceOf(unknown, ApiError)
      assert.containSubset(unknown, { status: 404, problem: { code: 'session_not_found' } })
      const intruder = createBureauClient({ baseUrl: yield* baseUrl, token: 'not-the-token' })
      const denied = yield* refused(intruder.projects.list())
      assert.containSubset(denied, { status: 401, problem: { code: 'unauthorized' } })
    }),
  )

  suite.effect('throws an ApiError of status 0 that names the url when no daemon answers', () =>
    Effect.gen(function* unreachable() {
      const offline = createBureauClient({ baseUrl: 'http://127.0.0.1:1', token: TEST_TOKEN })
      const failure = yield* refused(offline.health.check())
      assert.instanceOf(failure, ApiError)
      assert.containSubset(failure, { status: 0, url: 'http://127.0.0.1:1/api/v1/health' })
      assert.strictEqual(
        failure instanceof Error ? failure.message : '',
        'cannot reach the daemon at http://127.0.0.1:1/api/v1/health',
      )
    }),
  )
})
