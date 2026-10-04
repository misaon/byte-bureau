import { createTempRepo, tempDir, writeConfig } from '@bytebureau/kernel/testing'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ApiTestLayer, get, post, remove } from './testing.js'
import { createdSession, fakeProjectConfig, registeredProject } from './testing-sessions.js'

it.layer(ApiTestLayer())('POST /api/v1/projects over the test kernel', (suite) => {
  suite.effect('registers a repository with 201 and tells it as the kernel keeps it', () =>
    Effect.gen(function* registers() {
      const { repo, project, status } = yield* registeredProject
      assert.strictEqual(status, 201)
      const { name } = fakeProjectConfig.project
      assert.containSubset(project, { path: repo, name, defaultBranch: 'main' })
      assert.containSubset(project.config, {
        defaults: { employee: 'developer' },
        employees: { developer: { provider: 'fake', model: 'any' } },
      })
    }),
  )
})

it.layer(ApiTestLayer())('the refusals of POST /api/v1/projects over the test kernel', (suite) => {
  suite.effect('refuses a directory that is no repository with 422 and the kernel reason', () =>
    Effect.gen(function* refusesDirectory() {
      const plain = tempDir('bb-plain-')
      const refused = yield* post('/projects', { path: plain })
      assert.strictEqual(refused.status, 422)
      assert.include(refused.type, 'application/problem+json')
      assert.containSubset(refused.body, {
        code: 'workspace_not_a_repository',
        detail: `${plain} is not inside a git repository`,
      })
    }),
  )

  suite.effect('refuses a ByteBureau worktree with 422 workspace_is_bytebureau_worktree', () =>
    Effect.gen(function* refusesWorktree() {
      const { session } = yield* createdSession
      const workspace = yield* Effect.fromNullishOr(session.workspace)
      const refused = yield* post('/projects', { path: workspace.path })
      assert.strictEqual(refused.status, 422)
      assert.containSubset(refused.body, { code: 'workspace_is_bytebureau_worktree' })
    }),
  )

  suite.effect('refuses a project file the schema does not know with 422 config_invalid', () =>
    Effect.gen(function* refusesFile() {
      const repo = createTempRepo()
      writeConfig(repo, { version: 99 })
      const refused = yield* post('/projects', { path: repo })
      assert.strictEqual(refused.status, 422)
      assert.containSubset(refused.body, { code: 'config_invalid' })
      assert.include(JSON.stringify(refused.body), `${repo}/bytebureau.json/version`)
    }),
  )
})

it.layer(ApiTestLayer())('the refusals of the body of POST /api/v1/projects', (suite) => {
  suite.effect(
    'refuses a relative path with 422: the daemon cannot tell what it is relative to',
    () =>
      Effect.gen(function* refusesRelative() {
        const refused = yield* post('/projects', { path: 'repo' })
        assert.strictEqual(refused.status, 422)
        assert.containSubset(refused.body, {
          code: 'project_path_not_absolute',
          detail: 'repo is not an absolute path: the daemon cannot tell what it is relative to',
        })
      }),
  )

  suite.effect('refuses a body the schema does not know with 400 request_invalid', () =>
    Effect.gen(function* refusesBody() {
      const refused = yield* post('/projects', { directory: '/x' })
      assert.strictEqual(refused.status, 400)
      assert.include(refused.type, 'application/problem+json')
      assert.containSubset(refused.body, {
        code: 'request_invalid',
        detail: 'Payload: Missing key\n  at ["path"]',
      })
    }),
  )
})

it.layer(ApiTestLayer())('GET and DELETE /api/v1/projects/:id over the test kernel', (suite) => {
  suite.effect('lists a registered project and reads it by its id', () =>
    Effect.gen(function* reads() {
      const { project } = yield* registeredProject
      const listed = yield* get('/projects')
      assert.strictEqual(listed.status, 200)
      assert.containSubset(listed.body, [{ id: project.id }])
      const read = yield* get(`/projects/${project.id}`)
      assert.strictEqual(read.status, 200)
      assert.deepStrictEqual(read.body, project)
    }),
  )

  suite.effect('removes a project with 204 and answers 404 not_found for it afterwards', () =>
    Effect.gen(function* removes() {
      const { project } = yield* registeredProject
      assert.strictEqual((yield* remove(`/projects/${project.id}`)).status, 204)
      const gone = yield* get(`/projects/${project.id}`)
      assert.strictEqual(gone.status, 404)
      assert.include(gone.type, 'application/problem+json')
      assert.containSubset(gone.body, { code: 'not_found', status: 404 })
      assert.strictEqual((yield* remove(`/projects/${project.id}`)).status, 404)
    }),
  )

  suite.effect('does not remove a project that has sessions: 409 workspace_has_sessions', () =>
    Effect.gen(function* keeps() {
      const { project } = yield* createdSession
      const refused = yield* remove(`/projects/${project.id}`)
      assert.strictEqual(refused.status, 409)
      assert.containSubset(refused.body, { code: 'workspace_has_sessions' })
      assert.strictEqual((yield* get(`/projects/${project.id}`)).status, 200)
    }),
  )
})
