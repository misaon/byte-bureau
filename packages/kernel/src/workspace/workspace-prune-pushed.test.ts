import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { ProjectRegistry } from '../projects/project-registry.js'
import { createTempRepo, git } from '../testing/temp-repo.js'
import { TestLayer } from './workspace-manager-fixtures.js'
import { WorkspaceManager } from './workspace-manager.js'
import { provisionSession } from './workspace-session-fixtures.js'

const TODAY = Date.UTC(2026, 9, 3)
const ENDED = { status: 'completed', endedAt: '2026-09-01T00:00:00.000Z' } as const

// A commit of its own: the same change at the same second as another would be the very same commit
function commitFile(handle: { readonly path: string }, file: string): void {
  writeFileSync(path.join(handle.path, file), file)
  git(handle.path, 'add', file)
  git(handle.path, 'commit', '-q', '-m', `add ${file}`)
}

// A repository with an origin, registered as a project
const remoteProject = Effect.gen(function* registersRemoteProject() {
  const repo = createTempRepo({ withRemote: true })
  const config = { version: 1, project: { name: 'pushed' }, employees: {} }
  writeFileSync(path.join(repo, 'bytebureau.json'), JSON.stringify(config))
  return yield* (yield* ProjectRegistry).register(repo)
})

it.layer(TestLayer)('WorkspaceManager prune of pushed work', (suite) => {
  suite.effect('removes a worktree whose commits are on origin and keeps one whose are not', () =>
    Effect.gen(function* prunesPushedWork() {
      const project = yield* remoteProject
      const pushed = yield* provisionSession(project, { id: 'pushed-work', ...ENDED })
      const local = yield* provisionSession(project, { id: 'local-work', ...ENDED })
      commitFile(pushed, 'pushed.txt')
      commitFile(local, 'local.txt')
      git(pushed.path, 'push', '-q', 'origin', pushed.branch)
      yield* TestClock.setTime(TODAY)
      assert.deepStrictEqual(yield* (yield* WorkspaceManager).prune(project.id), {
        removed: [pushed.path],
        retained: [{ path: local.path, reason: 'commits not on origin' }],
      })
    }),
  )
})
