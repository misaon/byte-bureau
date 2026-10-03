import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { git } from '../testing/temp-repo.js'
import { TestLayer } from './workspace-manager-fixtures.js'
import { WorkspaceManager, type PruneReport } from './workspace-manager.js'
import {
  commitUnmerged,
  provisionSession,
  registerRepo,
  seedSession,
} from './workspace-session-fixtures.js'

// The clock of a test starts at the epoch; the sessions below ended days or weeks before this day
const TODAY = Date.UTC(2026, 9, 3)
const ENDED = { status: 'completed', endedAt: '2026-09-01T00:00:00.000Z' } as const

interface Summary {
  readonly removed: readonly string[]
  readonly retained: Readonly<Record<string, string>>
}

// Names stand for the paths, so the expectations do not depend on the temporary directories
const summarize = (report: PruneReport): Summary => ({
  removed: report.removed.map((removed) => path.basename(removed)),
  retained: Object.fromEntries(
    report.retained.map((entry) => [path.basename(entry.path), entry.reason]),
  ),
})

it.layer(TestLayer)('WorkspaceManager prune', (suite) => {
  suite.effect('prunes only terminal, pushed-or-merged, old worktrees and explains the rest', () =>
    Effect.gen(function* prunesOldWorkspaces() {
      const { project } = yield* registerRepo()
      yield* provisionSession(project, { id: 'old-clean', ...ENDED })
      const ahead = yield* provisionSession(project, { id: 'old-ahead', ...ENDED })
      const yesterday = { status: 'completed', endedAt: '2026-10-02T00:00:00.000Z' }
      yield* provisionSession(project, { id: 'fresh', ...yesterday })
      yield* provisionSession(project, { id: 'live', status: 'running' })
      commitUnmerged(ahead)
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      assert.deepStrictEqual(summarize(report), {
        removed: ['old-clean'],
        retained: {
          fresh: 'younger than 7 days',
          live: 'session is running',
          'old-ahead': 'commits not merged or pushed',
        },
      })
    }),
  )

  suite.effect('removes the worktree it reports and keeps the others on disk', () =>
    Effect.gen(function* removesReportedWorktree() {
      const { project } = yield* registerRepo()
      const clean = yield* provisionSession(project, { id: 'gone-clean', ...ENDED })
      const draft = yield* provisionSession(project, { id: 'kept-draft', ...ENDED })
      writeFileSync(path.join(draft.path, 'draft.txt'), 'x')
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      assert.deepStrictEqual(report.removed, [clean.path])
      assert.deepStrictEqual(report.retained, [{ path: draft.path, reason: 'uncommitted changes' }])
      assert.deepStrictEqual([existsSync(clean.path), existsSync(draft.path)], [false, true])
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager prune explanations', (suite) => {
  suite.effect('retains a worktree whose base ref no longer resolves as status unavailable', () =>
    Effect.gen(function* retainsWithoutStatus() {
      const { repo, project } = yield* registerRepo()
      git(repo, 'branch', 'topic')
      const handle = yield* provisionSession(
        project,
        { id: 'orphan', ...ENDED },
        { baseBranch: 'topic' },
      )
      git(repo, 'branch', '-D', 'topic')
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      assert.deepStrictEqual(report.removed, [])
      assert.deepStrictEqual(report.retained, [{ path: handle.path, reason: 'status unavailable' }])
    }),
  )

  suite.effect('retains the worktree of a session the manager has locked', () =>
    Effect.gen(function* retainsLockedSession() {
      const { project } = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const held = yield* provisionSession(project, { id: 'held', ...ENDED })
      yield* manager.lock('held')
      yield* TestClock.setTime(TODAY)
      const report = yield* manager.prune(project.id)
      const reason = 'session held is running'
      assert.deepStrictEqual(report, { removed: [], retained: [{ path: held.path, reason }] })
    }),
  )

  suite.effect('retains a worktree that git has locked', () =>
    Effect.gen(function* retainsPinnedWorktree() {
      const { repo, project } = yield* registerRepo()
      const pinned = yield* provisionSession(project, { id: 'pinned', ...ENDED })
      git(repo, 'worktree', 'lock', pinned.path)
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      const { removed, retained } = summarize(report)
      assert.deepStrictEqual(removed, [])
      assert.match(retained['pinned'] ?? '', /locked/u)
      assert.isTrue(existsSync(pinned.path))
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager prune retention', (suite) => {
  suite.effect(
    'keeps a worktree until the retention of the project has passed, to the second',
    () =>
      Effect.gen(function* keepsUntilRetentionEnds() {
        const { project } = yield* registerRepo()
        const due = { status: 'completed', endedAt: '2026-09-26T00:00:00.000Z' }
        const almost = { status: 'completed', endedAt: '2026-09-26T00:00:01.000Z' }
        yield* provisionSession(project, { id: 'due', ...due })
        yield* provisionSession(project, { id: 'almost', ...almost })
        yield* TestClock.setTime(TODAY)
        const report = yield* (yield* WorkspaceManager).prune(project.id)
        const expected = { removed: ['due'], retained: { almost: 'younger than 7 days' } }
        assert.deepStrictEqual(summarize(report), expected)
      }),
  )

  suite.effect('takes the retention from the workspace section of the project configuration', () =>
    Effect.gen(function* honoursRetainDays() {
      const { project } = yield* registerRepo({ retainDays: 60 })
      yield* provisionSession(project, { id: 'month-old', ...ENDED })
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      const expected = { removed: [], retained: { 'month-old': 'younger than 60 days' } }
      assert.deepStrictEqual(summarize(report), expected)
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager prune statuses', (suite) => {
  suite.effect('treats completed, stopped and errored sessions as over, and no other', () =>
    Effect.gen(function* prunesTerminalSessions() {
      const { project } = yield* registerRepo()
      for (const status of ['completed', 'stopped', 'errored', 'paused_usage_limit']) {
        yield* provisionSession(project, { id: status, status, endedAt: ENDED.endedAt })
      }
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      assert.deepStrictEqual(summarize(report), {
        removed: ['completed', 'errored', 'stopped'],
        retained: { paused_usage_limit: 'session is paused_usage_limit' },
      })
    }),
  )

  suite.effect('keeps a terminal session whose end time is missing or unreadable', () =>
    Effect.gen(function* keepsWithoutEndTime() {
      const { project } = yield* registerRepo()
      yield* provisionSession(project, { id: 'no-end', status: 'completed' })
      yield* provisionSession(project, { id: 'bad-end', status: 'errored', endedAt: 'long ago' })
      yield* TestClock.setTime(TODAY)
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      const reason = 'younger than 7 days'
      const expected = { removed: [], retained: { 'no-end': reason, 'bad-end': reason } }
      assert.deepStrictEqual(summarize(report), expected)
    }),
  )
})

it.layer(TestLayer)('WorkspaceManager prune scope', (suite) => {
  suite.effect('reports nothing for a project whose sessions have no workspace', () =>
    Effect.gen(function* prunesNothing() {
      const { project } = yield* registerRepo()
      yield* seedSession(project.id, { id: 'unprovisioned', ...ENDED })
      const report = yield* (yield* WorkspaceManager).prune(project.id)
      assert.deepStrictEqual(report, { removed: [], retained: [] })
    }),
  )

  suite.effect('prunes the project it is asked for, and every project when it is not asked', () =>
    Effect.gen(function* prunesWhichProjects() {
      const first = yield* registerRepo()
      const second = yield* registerRepo()
      const manager = yield* WorkspaceManager
      const one = yield* provisionSession(first.project, { id: 'first-old', ...ENDED })
      const two = yield* provisionSession(second.project, { id: 'second-old', ...ENDED })
      yield* TestClock.setTime(TODAY)
      yield* manager.prune(first.project.id)
      assert.deepStrictEqual([existsSync(one.path), existsSync(two.path)], [false, true])
      assert.include((yield* manager.prune()).removed, two.path)
    }),
  )
})
