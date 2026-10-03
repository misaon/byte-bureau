import { existsSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { StoreError } from '../errors.js'
import { TestLayer } from './workspace-manager-fixtures.js'
import { WorkspaceManager } from './workspace-manager.js'
import { provisionSession, registerRepo, seedSession } from './workspace-session-fixtures.js'

const ENDED = { status: 'completed', endedAt: '2026-09-01T00:00:00.000Z' } as const

it.layer(TestLayer)('WorkspaceManager list', (suite) => {
  suite.effect(
    'lists the workspaces of a project in session order, flagging a missing directory',
    () =>
      Effect.gen(function* listsWorkspaces() {
        const { project } = yield* registerRepo()
        const manager = yield* WorkspaceManager
        const live = yield* provisionSession(project, { id: 'live', status: 'running' })
        const gone = yield* provisionSession(project, { id: 'gone', ...ENDED })
        yield* seedSession(project.id, { id: 'bare', status: 'created' })
        yield* manager.destroy('gone', gone, { force: true })
        const shared = { projectId: project.id, baseRef: 'main' }
        assert.deepStrictEqual(yield* manager.list(project.id), [
          {
            ...shared,
            sessionId: 'gone',
            path: gone.path,
            branch: 'bb/gone',
            sessionStatus: 'completed',
            exists: false,
          },
          {
            ...shared,
            sessionId: 'live',
            path: live.path,
            branch: 'bb/live',
            sessionStatus: 'running',
            exists: true,
          },
        ])
      }),
  )

  suite.effect('lists nothing for a project without workspaces', () =>
    Effect.gen(function* listsNothing() {
      const { project } = yield* registerRepo()
      yield* seedSession(project.id, { id: 'unprovisioned', status: 'created' })
      assert.deepStrictEqual(yield* (yield* WorkspaceManager).list(project.id), [])
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager list across projects', (suite) => {
  suite.effect('lists every project when none is named', () =>
    Effect.gen(function* listsEveryProject() {
      const first = yield* registerRepo()
      const second = yield* registerRepo()
      const manager = yield* WorkspaceManager
      yield* provisionSession(first.project, { id: 'first-live', status: 'running' })
      yield* provisionSession(second.project, { id: 'second-live', status: 'running' })
      const everything = yield* manager.list()
      const ofSecond = yield* manager.list(second.project.id)
      assert.deepStrictEqual(
        everything.map((info) => info.sessionId),
        ['first-live', 'second-live'],
      )
      assert.deepStrictEqual(
        ofSecond.map((info) => info.sessionId),
        ['second-live'],
      )
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager records', (suite) => {
  suite.effect('fails with a store error naming the session when its record is not JSON', () =>
    Effect.gen(function* refusesTextThatIsNotJson() {
      const { project } = yield* registerRepo()
      yield* seedSession(project.id, { id: 'not-json', status: 'running', workspace: 'not json' })
      const error = yield* Effect.flip((yield* WorkspaceManager).list(project.id))
      assert.instanceOf(error, StoreError)
      assert.include(String(error.cause), 'not-json')
    }),
  )

  suite.effect('fails with a store error naming the session when its record is not a handle', () =>
    Effect.gen(function* refusesWrongShape() {
      const { project } = yield* registerRepo()
      yield* seedSession(project.id, {
        id: 'wrong-shape',
        status: 'running',
        workspace: '{"id":1}',
      })
      const error = yield* Effect.flip((yield* WorkspaceManager).list(project.id))
      assert.instanceOf(error, StoreError)
      assert.include(String(error.cause), 'wrong-shape')
    }),
  )

  suite.effect('prunes nothing while a record cannot be read', () =>
    Effect.gen(function* prunesNothingFromCorruptStore() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const clean = yield* provisionSession(project, { id: 'clean', ...ENDED })
      yield* seedSession(project.id, { id: 'corrupt', ...ENDED, workspace: '[]' })
      yield* TestClock.setTime(Date.UTC(2026, 9, 3))
      const error = yield* Effect.flip(manager.prune(project.id))
      assert.instanceOf(error, StoreError)
      assert.isTrue(existsSync(clean.path))
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager store', (suite) => {
  suite.effect('fails with a store error when the store cannot answer', () =>
    Effect.gen(function* failsWithoutStore() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      yield* (yield* SqlClient.SqlClient)`DROP TABLE sessions`
      const listing = yield* Effect.flip(manager.list(project.id))
      const pruning = yield* Effect.flip(manager.prune(project.id))
      assert.deepStrictEqual(
        [listing, pruning].map((error) => error instanceof StoreError),
        [true, true],
      )
    }),
  )
})
