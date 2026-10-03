import { realpathSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { StoreError, WorkspaceError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { createTempRepo, git } from '../testing/temp-repo.js'
import { ProjectRegistry } from './project-registry.js'
import { namedRepo, TestLayer } from './project-registry-fixtures.js'

// A session row of the project, which is what keeps a project from being removed
const addSession = (projectId: string): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* addsSession() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, workspace_json, status, created_at) VALUES (${`s-${projectId}`}, ${projectId}, 't', '{}', 'fake', '{}', 'stopped', '2026-10-03T00:00:00.000Z')`
  })

it.layer(TestLayer)('ProjectRegistry remove while sessions remain', (suite) => {
  suite.effect('refuses with the name of the project and the number of its sessions', () =>
    Effect.gen(function* refusesRemoval() {
      const registry = yield* ProjectRegistry
      const log = yield* EventLog
      const project = yield* registry.register(namedRepo('busy'))
      yield* addSession(project.id)
      const failure = yield* Effect.flip(registry.remove(project.id))
      assert.instanceOf(failure, WorkspaceError)
      assert.deepStrictEqual(
        [failure.code, failure.reason],
        ['has_sessions', 'project busy still has 1 session'],
      )
      assert.deepStrictEqual(yield* registry.get(project.id), project)
      const types = (yield* log.read({ projectId: project.id }, { from: 0 })).map(
        (event) => event.type,
      )
      assert.notInclude(types, 'project.removed')
    }),
  )
})

it.layer(TestLayer)('ProjectRegistry and session worktrees', (suite) => {
  suite.effect('refuses a session worktree that git added, even without its marker file', () =>
    Effect.gen(function* refusesPlacedWorktree() {
      const registry = yield* ProjectRegistry
      const repo = createTempRepo()
      const worktree = path.join(repo, '.bytebureau', 'worktrees', 's1')
      git(repo, 'worktree', 'add', '-q', worktree, '-b', 'bb/s1')
      const failure = yield* Effect.flip(registry.register(realpathSync(worktree)))
      assert.instanceOf(failure, WorkspaceError)
      assert.strictEqual(failure.code, 'is_bytebureau_worktree')
    }),
  )
})

it.layer(TestLayer)('ProjectRegistry list order', (suite) => {
  suite.effect('lists projects by name whatever its case, then by path', () =>
    Effect.gen(function* listsCaseInsensitive() {
      const registry = yield* ProjectRegistry
      const repos = ['beta', 'Gamma', 'alpha', 'alpha'].map((name) => namedRepo(name))
      yield* Effect.all(repos.map((repo) => registry.register(repo)))
      const listed = yield* registry.list()
      assert.deepStrictEqual(
        listed.map((project) => project.name),
        ['alpha', 'alpha', 'beta', 'Gamma'],
      )
      const alphas = listed.slice(0, 2).map((project) => project.path)
      assert.deepStrictEqual(alphas, alphas.toSorted())
    }),
  )
})

it.effect(
  'fails list and get with a StoreError that names a project whose snapshot no longer fits',
  () =>
    Effect.gen(function* failsOnBrokenSnapshot() {
      const registry = yield* ProjectRegistry
      const sql = yield* SqlClient.SqlClient
      const project = yield* registry.register(createTempRepo())
      yield* sql`UPDATE projects SET config_json = '{"version":2}' WHERE id = ${project.id}`
      const failures = [
        yield* Effect.flip(registry.list()),
        yield* Effect.flip(registry.get(project.id)),
      ]
      for (const failure of failures) {
        assert.instanceOf(failure, StoreError)
        assert.strictEqual(
          failure.message,
          `the configuration snapshot of project ${project.id} is unreadable`,
        )
      }
    }).pipe(Effect.provide(TestLayer)),
)
