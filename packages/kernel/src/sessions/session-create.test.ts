import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { git } from '../testing/temp-repo.js'
import { registerRepo, sessionOf, typesOf } from './session-fixtures.js'
import { firstOf, refusalOf } from './session-helpers.js'
import { sessionLayer } from './session-layers.js'
import { SessionManager } from './session-manager.js'

const CONFIG = {
  version: 1,
  project: { name: 'create-test' },
  employees: {
    reviewer: { name: 'Reviewer', provider: 'claude', model: 'm', permissionMode: 'supervised' },
  },
}
const WITH_TRUNK = { ...CONFIG, defaults: { branch: 'trunk' } }

it.layer(sessionLayer())('SessionManager create refusals', (suite) => {
  suite.effect('refuses a project nobody registered', () =>
    Effect.gen(function* refusesProject() {
      const sessions = yield* SessionManager
      const refused = yield* refusalOf(sessions.create({ projectId: 'nope', title: 'x' }))
      assert.strictEqual(refused, 'not_found: project nope is not registered')
      assert.deepStrictEqual(yield* sessions.list(), [])
    }),
  )

  suite.effect(
    'refuses an employee the project does not define, an inherited property included',
    () =>
      Effect.gen(function* refusesEmployee() {
        const project = yield* registerRepo(CONFIG)
        const sessions = yield* SessionManager
        const base = { projectId: project.id, title: 'x' }
        const missing = yield* refusalOf(sessions.create({ ...base, employeeId: 'ghost' }))
        const inherited = yield* refusalOf(sessions.create({ ...base, employeeId: 'constructor' }))
        assert.match(missing, /^employee_missing: employee "ghost" is not defined/u)
        assert.match(inherited, /^employee_missing: /u)
        assert.strictEqual((yield* sessions.list()).length, 0)
      }),
  )

  suite.effect('refuses a workspace runtime that is not there before it creates anything', () =>
    Effect.gen(function* refusesRuntime() {
      const project = yield* registerRepo({ ...CONFIG, workspace: { runtime: 'docker' } })
      const sessions = yield* SessionManager
      const input = { projectId: project.id, title: 'x', providerId: 'fake' }
      const refused = yield* refusalOf(sessions.create(input))
      assert.strictEqual(refused, 'runtime_missing: workspace runtime "docker" is not available')
      assert.strictEqual((yield* sessions.list()).length, 0)
    }),
  )
})

it.layer(sessionLayer())('SessionManager create from the configuration', (suite) => {
  suite.effect('replaces the provider of the employee with the one that is asked for', () =>
    Effect.gen(function* replacesProvider() {
      const project = yield* registerRepo(CONFIG)
      const sessions = yield* SessionManager
      const base = { projectId: project.id, title: 'x', employeeId: 'reviewer' }
      const session = yield* sessions.create({ ...base, providerId: 'fake' })
      assert.deepStrictEqual([session.providerId, session.employee.provider], ['fake', 'fake'])
      assert.strictEqual(session.employee.name, 'Reviewer')
    }),
  )

  suite.effect('takes the default employee, kept as it was when the session was created', () =>
    Effect.gen(function* takesDefaultEmployee() {
      const project = yield* registerRepo()
      const sessions = yield* SessionManager
      const base = { projectId: project.id, title: 'x', providerId: 'fake' }
      const session = yield* sessions.create(base)
      assert.strictEqual(session.employee.id, 'developer')
      assert.deepStrictEqual((yield* sessionOf(session.id)).employee, session.employee)
    }),
  )
})

it.layer(sessionLayer())('SessionManager create base branch', (suite) => {
  suite.effect(
    'starts the worktree from the branch of the project and from the one that is asked for',
    () =>
      Effect.gen(function* startsFromBranch() {
        const project = yield* registerRepo(WITH_TRUNK)
        git(project.path, 'branch', 'trunk')
        git(project.path, 'branch', 'develop')
        const sessions = yield* SessionManager
        const base = {
          projectId: project.id,
          title: 'x',
          providerId: 'fake',
          employeeId: 'reviewer',
        }
        const configured = yield* sessions.create(base)
        const asked = yield* sessions.create({ ...base, branch: 'develop' })
        const refs = [configured, asked].map((session) => session.workspace)
        assert.deepStrictEqual(
          refs.map((handle) => (handle === null ? null : handle.baseRef)),
          ['trunk', 'develop'],
        )
      }),
  )
})

it.layer(sessionLayer())('SessionManager create failures', (suite) => {
  suite.effect('marks a session errored when it cannot be provisioned and tells why', () =>
    Effect.gen(function* failsProvisioning() {
      const project = yield* registerRepo()
      const sessions = yield* SessionManager
      const base = { projectId: project.id, title: 'x', providerId: 'fake' }
      const refused = yield* refusalOf(sessions.create({ ...base, branch: 'no-such-branch' }))
      assert.match(refused, /^git_failed: .*no-such-branch/u)
      const session = yield* firstOf(yield* sessions.list())
      assert.strictEqual(session.status, 'errored')
      assert.deepStrictEqual(yield* typesOf(session.id), [
        'session.created',
        'session.provisioning',
        'session.errored',
      ])
    }),
  )
})
