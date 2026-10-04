import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { ApiTestLayer, get, post } from './testing.js'
import { createdSession } from './testing-sessions.js'

// A worktree is kept for seven days after its session ended, unless the project says otherwise
const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000

it.layer(ApiTestLayer())('GET /api/v1/workspaces and POST /api/v1/workspaces/prune', (suite) => {
  suite.effect('lists the worktree of a session, of its project and of every project', () =>
    Effect.gen(function* lists() {
      const { session, project } = yield* createdSession
      const workspace = yield* Effect.fromNullishOr(session.workspace)
      const info = {
        sessionId: session.id,
        projectId: project.id,
        path: workspace.path,
        branch: 'bb/create-hello',
        baseRef: 'main',
        sessionStatus: 'ready',
        exists: true,
      }
      assert.deepStrictEqual((yield* get(`/workspaces?project=${project.id}`)).body, [info])
      assert.containSubset((yield* get('/workspaces')).body, [info])
    }),
  )

  suite.effect('prunes nothing while its session is at work, and says why', () =>
    Effect.gen(function* prunesNothing() {
      const { session, project } = yield* createdSession
      const workspace = yield* Effect.fromNullishOr(session.workspace)
      const pruned = yield* post('/workspaces/prune', { projectId: project.id })
      assert.strictEqual(pruned.status, 200)
      assert.deepStrictEqual(pruned.body, {
        removed: [],
        retained: [{ path: workspace.path, reason: 'session is ready' }],
      })
      assert.containSubset((yield* post('/workspaces/prune', {})).body, { removed: [] })
    }),
  )
})

it.layer(ApiTestLayer())('GET /api/v1/plugins and GET /api/v1/providers', (suite) => {
  suite.effect('lists the bundled plugins as loaded, with the ports each offers', () =>
    Effect.gen(function* listsPlugins() {
      const listed = yield* get('/plugins')
      assert.strictEqual(listed.status, 200)
      assert.deepStrictEqual(listed.body, [
        {
          name: 'workspace-local',
          version: '0.0.0',
          state: 'loaded',
          ports: ['workspaceRuntimes:local'],
        },
        { name: 'agent-fake', version: '0.0.0', state: 'loaded', ports: ['agentProviders:fake'] },
      ])
    }),
  )

  suite.effect('lists the fake provider among the agent providers the plugins offer', () =>
    Effect.gen(function* listsProviders() {
      const listed = yield* get('/providers')
      assert.strictEqual(listed.status, 200)
      assert.deepStrictEqual(listed.body, [
        { id: 'fake', displayName: 'Fake agent (tests and CI)', supportsApiKey: true },
      ])
    }),
  )
})

// The clock of the suite is the test clock the handlers read, so the retention can run out at once
it.layer(ApiTestLayer())('POST /api/v1/workspaces/prune after the retention', (suite) => {
  suite.effect('removes the worktree of a session that ended long ago', () =>
    Effect.gen(function* prunesOld() {
      const { session, project } = yield* createdSession
      const workspace = yield* Effect.fromNullishOr(session.workspace)
      assert.strictEqual((yield* post(`/sessions/${session.id}/stop`)).status, 204)
      yield* TestClock.setTime(Date.now() + EIGHT_DAYS)
      const pruned = yield* post('/workspaces/prune', { projectId: project.id })
      assert.deepStrictEqual(pruned.body, { removed: [workspace.path], retained: [] })
      const listed = yield* get(`/workspaces?project=${project.id}`)
      assert.containSubset(listed.body, [{ sessionId: session.id, exists: false }])
    }),
  )
})
