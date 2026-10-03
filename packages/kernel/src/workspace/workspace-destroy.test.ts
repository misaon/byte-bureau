import { existsSync } from 'node:fs'
import type { WorkspaceStatus } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { TestLayer } from './workspace-manager-fixtures.js'
import { WorkspaceManager } from './workspace-manager.js'
import { makePrune } from './workspace-prune.js'
import {
  codeOf,
  eventsOf,
  provisionSession,
  registerRepo,
  seedSession,
} from './workspace-session-fixtures.js'

const TODAY = Date.UTC(2026, 9, 3)
const ENDED = { status: 'completed', endedAt: '2026-09-01T00:00:00.000Z' } as const

it.layer(TestLayer)('WorkspaceManager destroy by session id', (suite) => {
  suite.effect(
    'keys the lock and the events by the session id it is given, not the id of the handle',
    () =>
      Effect.gen(function* keysBySession() {
        const { project } = yield* registerRepo()
        const manager = yield* WorkspaceManager
        const handle = yield* provisionSession(project, { id: 'keyed', status: 'running' })
        const destroy = manager.destroy(
          'keyed',
          { ...handle, id: 'not-the-session' },
          { force: true },
        )
        const refused = yield* Effect.flip(Effect.andThen(manager.lock('keyed'), destroy))
        yield* Effect.andThen(manager.unlock('keyed'), destroy)
        assert.deepStrictEqual([codeOf(refused), existsSync(handle.path)], ['locked', false])
        const events = [(yield* eventsOf('keyed')).slice(1), yield* eventsOf('not-the-session')]
        assert.deepStrictEqual(events, [
          [{ type: 'workspace.destroyed', payload: { path: handle.path } }],
          [],
        ])
      }),
  )
})

const CLEAN: WorkspaceStatus = {
  dirty: false,
  ahead: 0,
  behind: 0,
  pushed: false,
  locked: false,
  branch: 'bb/raced',
}

// The status was clean when prune read it, and destroy found changes by the time it looked again
it.layer(TestLayer)('WorkspaceManager prune race', (suite) => {
  suite.effect(
    'reports a worktree that destroy kept as retained, with the reason destroy gave',
    () =>
      Effect.gen(function* reportsKeptWorktree() {
        const { project } = yield* registerRepo()
        const handle = {
          id: 'raced',
          runtimeId: 'local',
          path: project.path,
          branch: 'bb/raced',
          baseRef: 'main',
        }
        yield* seedSession(project.id, { id: 'raced', ...ENDED, workspace: JSON.stringify(handle) })
        const prune = makePrune(yield* SqlClient.SqlClient, {
          status: () => Effect.succeed(CLEAN),
          destroy: () => Effect.succeed({ removed: false, reason: 'uncommitted changes' } as const),
        })
        yield* TestClock.setTime(TODAY)
        assert.deepStrictEqual(yield* prune(project.id), {
          removed: [],
          retained: [{ path: project.path, reason: 'uncommitted changes' }],
        })
      }),
  )
})
