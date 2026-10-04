import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { EventLog } from '../events/event-log.js'
import { doubtingPlugin } from '../profiles/failing-fixtures.js'
import { codeOf, loadedProfiles } from '../profiles/profile-fixtures.js'
import { git } from '../testing/temp-repo.js'
import { registerRepo, sessionOf, startSession, typesOf, waitFor } from './session-fixtures.js'
import { firstOf, refusalOf } from './session-helper-fixtures.js'
import { sessionLayer } from './session-layer-fixtures.js'
import { SessionManager } from './session-manager.js'

const CONFIG = {
  version: 1,
  project: { name: 'create-test' },
  employees: {
    reviewer: { name: 'Reviewer', provider: 'claude', model: 'm', permissionMode: 'supervised' },
  },
}
const WITH_TRUNK = { ...CONFIG, defaults: { branch: 'trunk' } }
const CANARY = 'sk-canary-create'
const WARNING = 'session.warning'
const FAKE_DEVELOPER = { name: 'Dev', provider: 'fake', model: 'm', permissionMode: 'supervised' }
const SLOW_FLAVOUR = {
  version: 1,
  project: { name: 'flavoured' },
  employees: { developer: FAKE_DEVELOPER },
  providers: { fake: { passEnv: ['X'], flavour: 'slow' } },
}

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

it.layer(sessionLayer())('SessionManager create under a named profile', (suite) => {
  suite.effect(
    'stores the profile and runs the agent with its key set, which no event carries',
    () =>
      Effect.gen(function* runsUnderKey() {
        const profiles = yield* loadedProfiles
        yield* profiles.add({ providerId: 'fake', name: 'key', kind: 'api_key', apiKey: CANARY })
        const session = yield* startSession({ profileId: 'fake/key' })
        yield* (yield* SessionManager).prompt(session.id, { text: 'go' })
        const warning = yield* waitFor(session.id, WARNING)
        assert.deepStrictEqual(
          [session.profileId, (yield* sessionOf(session.id)).profileId, warning.payload],
          ['fake/key', 'fake/key', { kind: 'env', message: 'api key: present' }],
        )
        const events = yield* EventLog.use((log) => log.read({}, { from: 0 }))
        assert.notInclude(JSON.stringify(events), CANARY)
      }),
  )
})

it.layer(sessionLayer())('SessionManager create under the default profile', (suite) => {
  suite.effect(
    'runs without a profile while its provider has none, and under the default one after',
    () =>
      Effect.gen(function* takesDefault() {
        const before = yield* startSession()
        yield* (yield* SessionManager).prompt(before.id, { text: 'go' })
        const warning = yield* waitFor(before.id, WARNING)
        yield* (yield* loadedProfiles).add({ providerId: 'fake', name: 'work', kind: 'login' })
        const after = yield* startSession()
        assert.deepStrictEqual(
          [before.profileId, warning.payload, after.profileId],
          [null, { kind: 'env', message: 'api key: absent' }, 'fake/work'],
        )
      }),
  )
})

it.layer(sessionLayer({ extraPlugins: [doubtingPlugin] }))(
  'SessionManager create refusals of a profile',
  (suite) => {
    suite.effect(
      'refuses a profile nobody holds and one of another provider before it creates anything',
      () =>
        Effect.gen(function* refusesProfiles() {
          const project = yield* registerRepo()
          const profiles = yield* loadedProfiles
          yield* profiles.add({ providerId: 'doubting', name: 'd', kind: 'login' })
          const sessions = yield* SessionManager
          const base = { projectId: project.id, title: 'x', providerId: 'fake' }
          const refused = yield* Effect.all([
            codeOf(sessions.create({ ...base, profileId: 'fake/nope' })),
            codeOf(sessions.create({ ...base, profileId: 'doubting/d' })),
          ])
          assert.deepStrictEqual(refused, ['not_found', 'invalid'])
          assert.deepStrictEqual(yield* sessions.list(), [])
        }),
    )
  },
)

it.layer(sessionLayer())('SessionManager create with provider options', (suite) => {
  suite.effect('hands the fake agent the options of its provider, which pick its script', () =>
    Effect.gen(function* picksScript() {
      const sessions = yield* SessionManager
      const session = yield* startSession({}, SLOW_FLAVOUR)
      yield* sessions.prompt(session.id, { text: 'take your time' })
      yield* waitFor(session.id, 'turn.started')
      yield* sessions.interrupt(session.id)
      yield* waitFor(session.id, 'turn.interrupted')
      const types = yield* typesOf(session.id)
      assert.deepStrictEqual(
        types.filter((type) => type === 'tool.started' || type === 'ask.requested'),
        [],
      )
    }),
  )
})
