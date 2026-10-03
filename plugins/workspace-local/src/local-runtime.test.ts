import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkspaceSpec } from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import { LocalWorkspaceRuntime } from './local-runtime.js'
import { SESSION_ID, createRuntime, readJson, workspaceSpec } from './testing/fixtures.js'
import { createTempRepo, git, tempDir } from './testing/temp-repo.js'

const worktreeOf = (repo: string): string => path.join(repo, '.bytebureau', 'worktrees', SESSION_ID)

// Every session asks for the same branch name
const sameBranch = (sessionId: string, projectPath: string): WorkspaceSpec =>
  workspaceSpec(projectPath, { sessionId, branch: 'bb/x' })

describe(LocalWorkspaceRuntime, () => {
  it('provisions a worktree on the requested branch from the local base branch', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const exclude = path.join(repo, '.git', 'info', 'exclude')
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(handle.path).toBe(worktreeOf(repo))
    expect(git(handle.path, 'branch', '--show-current')).toBe('bb/add-hello')
    expect(handle.baseRef).toBe('main')
    expect(readFileSync(exclude, 'utf8')).toContain('.bytebureau/')
    expect(readJson(path.join(handle.path, '.bytebureau-session.json'))).toMatchObject({
      sessionId: SESSION_ID,
    })
  })

  it('describes the worktree in the handle it returns', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(handle).toStrictEqual({
      id: SESSION_ID,
      runtimeId: 'local',
      path: worktreeOf(repo),
      branch: 'bb/add-hello',
      baseRef: 'main',
    })
  })

  it('never touches a dirty main checkout', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    writeFileSync(path.join(repo, 'README.md'), '# changed\n')
    writeFileSync(path.join(repo, 'scratch.txt'), 'x\n')
    await createRuntime().provision(workspaceSpec(repo))
    expect(git(repo, 'status', '--porcelain')).toBe('M README.md\n?? scratch.txt')
    expect(readFileSync(path.join(repo, 'README.md'), 'utf8')).toBe('# changed\n')
    expect(git(repo, 'branch', '--show-current')).toBe('main')
  })
})

describe('project checks', () => {
  it('refuses a directory that is not a repository and one that is a ByteBureau worktree', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(createTempRepo()))
    const plain = tempDir('bb-plain-')
    await expect(runtime.provision(workspaceSpec(plain))).rejects.toMatchObject({
      code: 'not_a_repository',
    })
    await expect(runtime.provision(workspaceSpec(handle.path))).rejects.toMatchObject({
      code: 'is_bytebureau_worktree',
    })
  })

  it('provisions at the repository toplevel when the project path lies inside it', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const inside = path.join(repo, 'src', 'deep')
    mkdirSync(inside, { recursive: true })
    const handle = await createRuntime().provision(workspaceSpec(inside))
    expect(handle.path).toBe(worktreeOf(repo))
    expect(git(handle.path, 'rev-parse', '--show-toplevel')).toBe(handle.path)
  })
})

describe('project paths', () => {
  it('refuses a project path that is not a directory', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const missing = workspaceSpec(path.join(tempDir('bb-plain-'), 'missing'))
    const file = workspaceSpec(path.join(repo, 'README.md'))
    await expect(createRuntime().provision(missing)).rejects.toMatchObject({
      code: 'not_a_repository',
    })
    await expect(createRuntime().provision(file)).rejects.toMatchObject({
      code: 'not_a_repository',
    })
  })

  it('refuses a repository that holds a session marker', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    writeFileSync(path.join(repo, '.bytebureau-session.json'), '{}')
    await expect(createRuntime().provision(workspaceSpec(repo))).rejects.toMatchObject({
      code: 'is_bytebureau_worktree',
    })
  })

  it('still knows a ByteBureau worktree whose marker was deleted', async () => {
    expect.hasAssertions()
    const runtime = createRuntime()
    const handle = await runtime.provision(workspaceSpec(createTempRepo()))
    rmSync(path.join(handle.path, '.bytebureau-session.json'))
    await expect(runtime.provision(workspaceSpec(handle.path))).rejects.toMatchObject({
      code: 'is_bytebureau_worktree',
    })
  })
})

describe('branch names', () => {
  it('suffixes the branch when it already exists', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    git(repo, 'branch', 'bb/add-hello')
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(handle.branch).toBe('bb/add-hello-2')
  })

  it('counts up past every suffix that is taken', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    git(repo, 'branch', 'bb/add-hello')
    git(repo, 'branch', 'bb/add-hello-2')
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(handle.branch).toBe('bb/add-hello-3')
    expect(git(handle.path, 'branch', '--show-current')).toBe('bb/add-hello-3')
  })

  it('gives sessions that start at once a name each, however they name the project', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const inside = path.join(repo, 'src')
    mkdirSync(inside)
    const runtime = createRuntime()
    const handles = await Promise.all([
      runtime.provision(sameBranch('a', repo)),
      runtime.provision(sameBranch('b', inside)),
      runtime.provision(sameBranch('c', repo)),
    ])
    expect(handles.map((handle) => handle.branch).toSorted()).toStrictEqual([
      'bb/x',
      'bb/x-2',
      'bb/x-3',
    ])
    expect(handles.map((handle) => existsSync(handle.path))).toStrictEqual([true, true, true])
  })
})
