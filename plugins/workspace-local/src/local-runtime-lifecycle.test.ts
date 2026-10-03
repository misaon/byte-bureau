import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkspaceHandle } from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import { WorkspaceError } from './errors.js'
import type { LocalWorkspaceRuntime } from './local-runtime.js'
import { createRuntime, readLines, scriptedSpawner, workspaceSpec } from './testing/fixtures.js'
import { createTempRepo, git, tempDir } from './testing/temp-repo.js'

// A provisioned worktree that holds an uncommitted file
async function dirtyWorktree(runtime: LocalWorkspaceRuntime): Promise<WorkspaceHandle> {
  const handle = await runtime.provision(workspaceSpec(createTempRepo()))
  writeFileSync(path.join(handle.path, 'new.txt'), 'hi\n')
  return handle
}

describe('status', () => {
  it('reports a fresh worktree as clean', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(createTempRepo()))
    await expect(runtime.status(handle)).resolves.toStrictEqual({
      dirty: false,
      ahead: 0,
      behind: 0,
      locked: false,
      branch: 'bb/add-hello',
    })
  })

  it('counts the commits ahead of and behind the base ref', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(repo))
    git(handle.path, 'commit', '--allow-empty', '-q', '-m', 'work')
    git(repo, 'commit', '--allow-empty', '-q', '-m', 'upstream one')
    git(repo, 'commit', '--allow-empty', '-q', '-m', 'upstream two')
    await expect(runtime.status(handle)).resolves.toMatchObject({
      dirty: false,
      ahead: 1,
      behind: 2,
    })
  })

  it('reports uncommitted changes', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await dirtyWorktree(runtime)
    await expect(runtime.status(handle)).resolves.toMatchObject({ dirty: true, locked: false })
  })
})

describe('locks', () => {
  it('reports a lock for the locked worktree only', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const runtime = createRuntime()
    const locked = await runtime.provision(workspaceSpec(repo))
    const other = await runtime.provision(
      workspaceSpec(repo, { sessionId: 'other', branch: 'bb/o' }),
    )
    git(repo, 'worktree', 'lock', locked.path)
    await expect(runtime.status(other)).resolves.toMatchObject({ locked: false })
    await expect(runtime.status(locked)).resolves.toMatchObject({ locked: true })
  })

  it('refuses to destroy a locked worktree even with force', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(repo))
    git(repo, 'worktree', 'lock', handle.path)
    await expect(runtime.destroy(handle, { force: true })).rejects.toMatchObject({ code: 'locked' })
    expect(existsSync(handle.path)).toBe(true)
  })
})

describe('git failures', () => {
  it('reports a git failure as a workspace error', async () => {
    expect.hasAssertions()
    const gone = {
      id: 's',
      runtimeId: 'local',
      path: tempDir('bb-plain-'),
      branch: 'x',
      baseRef: 'main',
    }
    const failure = createRuntime().status(gone)
    await expect(failure).rejects.toBeInstanceOf(WorkspaceError)
    await expect(failure).rejects.toMatchObject({ code: 'git_failed' })
  })

  it('reports a git that died from a signal as a failure', async () => {
    expect.hasAssertions()
    const handle = await createRuntime().provision(workspaceSpec(createTempRepo()))
    const killed = scriptedSpawner(() => "process.kill(process.pid, 'SIGKILL')")
    await expect(createRuntime(killed).status(handle)).rejects.toMatchObject({ code: 'git_failed' })
  })
})

describe('destroy', () => {
  it('removes a clean worktree without force and keeps its branch', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(repo))
    await runtime.destroy(handle)
    expect(existsSync(handle.path)).toBe(false)
    expect(git(repo, 'branch', '--list', 'bb/add-hello')).toBe('bb/add-hello')
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(handle.path)
  })

  it('refuses to destroy a dirty worktree without force, then removes it with force', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await dirtyWorktree(runtime)
    const refusal = runtime.destroy(handle)
    await expect(refusal).rejects.toBeInstanceOf(WorkspaceError)
    await expect(refusal).rejects.toMatchObject({ code: 'dirty' })
    expect(existsSync(path.join(handle.path, 'new.txt'))).toBe(true)
    await runtime.destroy(handle, { force: true })
    expect(existsSync(handle.path)).toBe(false)
  })
})

describe('exec', () => {
  it('runs a command in the worktree', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(createTempRepo()))
    const args = ['rev-parse', '--show-toplevel']
    const child = await runtime.exec(handle, { command: 'git', args })
    await expect(readLines(child.stdout)).resolves.toStrictEqual([handle.path])
    await expect(child.exited).resolves.toStrictEqual({ code: 0, signal: null })
  })
})
