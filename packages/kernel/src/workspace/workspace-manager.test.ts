import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { Project } from '../projects/project-registry.js'
import { git } from '../testing/temp-repo.js'
import { TestLayer } from './workspace-manager-fixtures.js'
import { WorkspaceManager } from './workspace-manager.js'
import {
  codeOf,
  eventsOf,
  provisionSession,
  registerRepo,
  storedWorkspaceOf,
} from './workspace-session-fixtures.js'

const PROVISIONING = 'provisioning'

it.layer(TestLayer)('WorkspaceManager provision', (suite) => {
  suite.effect(
    'provisions on bb/<slug>, records the handle on the session and emits workspace.provisioned',
    () =>
      Effect.gen(function* provisionsWorkspace() {
        const { repo, project } = yield* registerRepo()
        const seed = { id: 'session-1', status: PROVISIONING }
        const handle = yield* provisionSession(project, seed, { title: 'Add hello' })
        assert.strictEqual(handle.branch, 'bb/add-hello')
        assert.strictEqual(handle.path, path.join(repo, '.bytebureau', 'worktrees', 'session-1'))
        const payload = {
          path: handle.path,
          branch: handle.branch,
          baseRef: 'main',
          runtimeId: 'local',
        }
        const announced = [{ type: 'workspace.provisioned', projectId: project.id, payload }]
        assert.deepStrictEqual(yield* eventsOf('session-1'), announced)
        assert.deepStrictEqual(yield* storedWorkspaceOf('session-1'), handle)
      }),
  )

  suite.effect('fails for a runtime nobody provides and leaves the session and the log alone', () =>
    Effect.gen(function* refusesUnknownRuntime() {
      const { project } = yield* registerRepo()
      const seed = { id: 'session-2', status: PROVISIONING }
      const error = yield* Effect.flip(provisionSession(project, seed, { runtimeId: 'nobody' }))
      assert.strictEqual(codeOf(error), 'runtime_missing')
      assert.deepStrictEqual(yield* eventsOf('session-2'), [])
      assert.deepStrictEqual(yield* storedWorkspaceOf('session-2'), {})
    }),
  )

  suite.effect('passes a failure of the runtime on with its code and records nothing', () =>
    Effect.gen(function* relaysRuntimeFailure() {
      const { project } = yield* registerRepo()
      const missing = { ...project, path: path.join(project.path, 'missing') }
      const error = yield* Effect.flip(
        provisionSession(missing, { id: 'session-3', status: PROVISIONING }),
      )
      assert.strictEqual(codeOf(error), 'not_a_repository')
      assert.deepStrictEqual(yield* eventsOf('session-3'), [])
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager provision together', (suite) => {
  suite.effect('keeps the branches of sessions that share a title and start together apart', () =>
    Effect.gen(function* provisionsTogether() {
      const { project } = yield* registerRepo()
      const title = { title: 'Same task' }
      const [first, second] = yield* Effect.all(
        [
          provisionSession(project, { id: 'twin-1', status: PROVISIONING }, title),
          provisionSession(project, { id: 'twin-2', status: PROVISIONING }, title),
        ],
        { concurrency: 'unbounded' },
      )
      assert.deepStrictEqual([first.branch, second.branch].toSorted(), [
        'bb/same-task',
        'bb/same-task-2',
      ])
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager provision of ignored files', (suite) => {
  suite.effect('copies the files the project configuration lists into the worktree', () =>
    Effect.gen(function* copiesListedFiles() {
      const { repo, project } = yield* registerRepo({ copyIgnored: ['local.cfg'] })
      writeFileSync(path.join(repo, 'local.cfg'), 'a')
      writeFileSync(path.join(repo, '.env'), 'b')
      const handle = yield* provisionSession(project, { id: 'session-4', status: PROVISIONING })
      assert.isTrue(existsSync(path.join(handle.path, 'local.cfg')))
      assert.isFalse(existsSync(path.join(handle.path, '.env')))
    }),
  )

  suite.effect('copies nothing when the configuration has no workspace section or no list', () =>
    Effect.gen(function* copiesNothing() {
      const { repo, project } = yield* registerRepo()
      writeFileSync(path.join(repo, '.env'), 'b')
      const bare: Project = {
        ...project,
        config: { version: 1, project: { name: 'bare' }, employees: {} },
      }
      const unlisted: Project = {
        ...bare,
        config: { ...bare.config, workspace: { runtime: 'local' } },
      }
      const first = yield* provisionSession(bare, { id: 'session-5', status: PROVISIONING })
      const second = yield* provisionSession(unlisted, { id: 'session-6', status: PROVISIONING })
      assert.isFalse(existsSync(path.join(first.path, '.env')))
      assert.isFalse(existsSync(path.join(second.path, '.env')))
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager destroy', (suite) => {
  suite.effect('refuses to destroy a locked workspace until it is unlocked', () =>
    Effect.gen(function* refusesLockedWorkspace() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const handle = yield* provisionSession(project, { id: 'session-7', status: 'running' })
      yield* manager.lock('session-7')
      const refused = yield* Effect.flip(manager.destroy(handle, { force: true }))
      assert.strictEqual(codeOf(refused), 'locked')
      yield* manager.unlock('session-7')
      yield* manager.destroy(handle)
      assert.isFalse(existsSync(handle.path))
    }),
  )

  suite.effect('retains a workspace with uncommitted changes and destroys it when forced', () =>
    Effect.gen(function* retainsDirtyWorkspace() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const handle = yield* provisionSession(project, { id: 'session-8', status: 'completed' })
      writeFileSync(path.join(handle.path, 'dirty.txt'), 'x')
      yield* manager.destroy(handle)
      assert.isTrue(existsSync(handle.path))
      yield* manager.destroy(handle, { force: true })
      assert.isFalse(existsSync(handle.path))
      const later = (yield* eventsOf('session-8')).slice(1)
      assert.deepStrictEqual(later, [
        {
          type: 'workspace.retained',
          payload: { path: handle.path, reason: 'uncommitted changes' },
        },
        { type: 'workspace.destroyed', payload: { path: handle.path } },
      ])
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager destroy without status', (suite) => {
  suite.effect('retains a workspace whose status is unavailable and destroys it when forced', () =>
    Effect.gen(function* retainsWithoutStatus() {
      const { repo, project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const handle = yield* provisionSession(project, { id: 'session-11', status: 'completed' })
      git(repo, 'branch', '-m', 'main', 'trunk')
      yield* manager.destroy(handle)
      assert.isTrue(existsSync(handle.path))
      yield* manager.destroy(handle, { force: true })
      assert.isFalse(existsSync(handle.path))
      const later = (yield* eventsOf('session-11')).slice(1)
      assert.deepStrictEqual(later, [
        {
          type: 'workspace.retained',
          payload: { path: handle.path, reason: 'status unavailable' },
        },
        { type: 'workspace.destroyed', payload: { path: handle.path } },
      ])
    }),
  )

  suite.effect('leaves a worktree that git has locked in place, even when forced', () =>
    Effect.gen(function* keepsPinnedWorktree() {
      const { repo, project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const handle = yield* provisionSession(project, { id: 'session-12', status: 'completed' })
      git(repo, 'worktree', 'lock', handle.path)
      const refused = yield* Effect.flip(manager.destroy(handle, { force: true }))
      assert.strictEqual(codeOf(refused), 'locked')
      assert.isTrue(existsSync(handle.path))
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager status', (suite) => {
  suite.effect('reports what the runtime knows about the workspace', () =>
    Effect.gen(function* reportsStatus() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const handle = yield* provisionSession(project, { id: 'session-9', status: 'running' })
      writeFileSync(path.join(handle.path, 'draft.txt'), 'x')
      const expected = { dirty: true, ahead: 0, behind: 0, locked: false, branch: 'bb/session-9' }
      assert.deepStrictEqual(yield* manager.status(handle), expected)
    }),
  )

  suite.effect('refuses a handle of a runtime nobody provides', () =>
    Effect.gen(function* refusesStrayHandle() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const handle = yield* provisionSession(project, { id: 'session-10', status: 'running' })
      const stray = { ...handle, runtimeId: 'nobody' }
      const statusError = yield* Effect.flip(manager.status(stray))
      const destroyError = yield* Effect.flip(manager.destroy(stray))
      const forcedError = yield* Effect.flip(manager.destroy(stray, { force: true }))
      const codes = [statusError, destroyError, forcedError].map((error) => codeOf(error))
      assert.deepStrictEqual(codes, ['runtime_missing', 'runtime_missing', 'runtime_missing'])
      assert.isTrue(existsSync(handle.path))
    }),
  )
})
