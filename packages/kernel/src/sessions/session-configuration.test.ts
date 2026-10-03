import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { ProjectRegistry } from '../projects/project-registry.js'
import { writeConfig } from '../testing/repo-config.js'
import { git } from '../testing/temp-repo.js'
import { registerRepo } from './session-fixtures.js'
import { sessionLayer } from './session-layer-fixtures.js'
import { SessionManager } from './session-manager.js'

const DEVELOPER = { name: 'Developer', provider: 'fake', model: 'm', permissionMode: 'supervised' }
const employees = { developer: DEVELOPER, reviewer: { ...DEVELOPER, name: 'Reviewer' } }
const CONFIG = { version: 1, project: { name: 'configured' }, employees }

// The kernel was started with these variables in its environment
const withEnv = sessionLayer({
  env: { BYTEBUREAU_EMPLOYEE: 'reviewer', BYTEBUREAU_BRANCH: 'topic' },
})

const baseOf = (session: { readonly workspace: { readonly baseRef: string } | null }): string =>
  session.workspace === null ? '' : session.workspace.baseRef

it.layer(withEnv)('SessionManager create with the environment of the kernel', (suite) => {
  suite.effect(
    'takes the employee and the base branch of BYTEBUREAU_EMPLOYEE and BYTEBUREAU_BRANCH, unless the caller names them',
    () =>
      Effect.gen(function* readsEnvironment() {
        const project = yield* registerRepo(CONFIG)
        git(project.path, 'branch', 'topic')
        const sessions = yield* SessionManager
        const byEnv = yield* sessions.create({ projectId: project.id, title: 'by env' })
        const named = yield* sessions.create({
          projectId: project.id,
          title: 'named',
          branch: 'main',
          employeeId: 'developer',
        })
        assert.deepStrictEqual(
          [byEnv.employee.id, baseOf(byEnv), named.employee.id, baseOf(named)],
          ['reviewer', 'topic', 'developer', 'main'],
        )
      }),
  )
})

it.layer(sessionLayer())('SessionManager create with the configuration as it stands', (suite) => {
  suite.effect('reads the project file again, while the registered snapshot stays as it was', () =>
    Effect.gen(function* readsCurrentConfiguration() {
      const project = yield* registerRepo(CONFIG)
      writeConfig(project.path, { ...CONFIG, defaults: { employee: 'reviewer' } })
      const session = yield* (yield* SessionManager).create({
        projectId: project.id,
        title: 'later',
      })
      const stored = yield* (yield* ProjectRegistry).get(project.id)
      assert.strictEqual(session.employee.id, 'reviewer')
      assert.deepStrictEqual(stored === undefined ? null : stored.config.defaults, {
        employee: 'developer',
      })
    }),
  )
})
