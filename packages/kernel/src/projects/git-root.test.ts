import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createTempRepo, git, tempDir } from '../testing/temp-repo.js'
import { defaultBranchOf, findGitRoot, isByteBureauWorktree } from './git-root.js'

// A variable of this process for the rest of the test
function setEnv(name: string, value: string): void {
  const before = process.env[name]
  process.env[name] = value
  onTestFinished(() => {
    if (before === undefined) {
      Reflect.deleteProperty(process.env, name)
    } else {
      process.env[name] = before
    }
  })
}

// A session worktree where provisioning puts one, added by git itself, without the marker file
function placedWorktree(): string {
  const repo = createTempRepo()
  const worktree = path.join(repo, '.bytebureau', 'worktrees', 's1')
  git(repo, 'worktree', 'add', '-q', worktree, '-b', 'bb/s1')
  return realpathSync(worktree)
}

// A repository that has been initialised and holds no commit yet
function emptyRepo(): string {
  const repo = tempDir('bb-empty-')
  git(repo, 'init', '-q', '-b', 'main')
  return repo
}

describe(findGitRoot, () => {
  it('finds the toplevel from a nested directory and null outside a repository', () => {
    const repo = createTempRepo()
    mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })
    expect(findGitRoot(path.join(repo, 'src', 'deep'))).toBe(repo)
    expect(findGitRoot(tempDir('bb-plain-'))).toBeNull()
  })

  it('finds no toplevel for a directory that does not exist', () => {
    const missing = path.join(tempDir('bb-plain-'), 'nowhere')
    expect(findGitRoot(missing)).toBeNull()
  })

  it('reports the physical toplevel when asked through a symlink', () => {
    const repo = createTempRepo()
    const link = path.join(tempDir('bb-link-'), 'repo')
    symlinkSync(repo, link)
    expect(findGitRoot(link)).toBe(repo)
  })

  it('finds the toplevel of a repository without commits', () => {
    const repo = emptyRepo()
    expect(findGitRoot(repo)).toBe(repo)
  })

  it('keeps a space at the end of the path, cutting only the newline git ends with', () => {
    const repo = path.join(tempDir('bb-space-'), 'repo ')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    expect(findGitRoot(repo)).toBe(repo)
  })

  it('runs git without the variables the kernel does not pass on, such as GIT_DIR', () => {
    const repo = createTempRepo()
    setEnv('GIT_DIR', path.join(tempDir('bb-nowhere-'), 'missing.git'))
    expect(findGitRoot(repo)).toBe(repo)
  })

  it('finds the toplevel of a session worktree that git added', () => {
    const worktree = placedWorktree()
    expect(findGitRoot(worktree)).toBe(worktree)
  })
})

describe(isByteBureauWorktree, () => {
  it('recognises the session marker file', () => {
    const repo = createTempRepo()
    expect(isByteBureauWorktree(repo)).toBe(false)
    writeFileSync(path.join(repo, '.bytebureau-session.json'), '{}')
    expect(isByteBureauWorktree(repo)).toBe(true)
  })

  it('recognises a worktree where provisioning puts one, without its marker', () => {
    expect(isByteBureauWorktree(placedWorktree())).toBe(true)
    expect(isByteBureauWorktree('/repo/.bytebureau/worktrees')).toBe(false)
    expect(isByteBureauWorktree('/repo/.bytebureau/worktrees/s1/src')).toBe(false)
  })
})

describe(defaultBranchOf, () => {
  it('uses origin/HEAD when present and the checked-out branch otherwise', () => {
    expect(defaultBranchOf(createTempRepo())).toBe('main')
    expect(defaultBranchOf(createTempRepo({ withRemote: true }))).toBe('main')
  })

  it('takes the checked-out branch of a repository without a remote, such as master', () => {
    const repo = createTempRepo()
    git(repo, 'branch', '-m', 'main', 'master')
    expect(defaultBranchOf(repo)).toBe('master')
  })

  it('falls back to main when nothing is checked out', () => {
    const repo = createTempRepo()
    git(repo, 'checkout', '-q', '--detach')
    expect(defaultBranchOf(repo)).toBe('main')
    expect(defaultBranchOf(emptyRepo())).toBe('main')
  })

  it('reads origin/HEAD in full, so a local branch named origin/main does not confuse it', () => {
    const repo = createTempRepo({ withRemote: true })
    git(repo, 'remote', 'set-head', 'origin', 'main')
    git(repo, 'branch', 'origin/main')
    expect(defaultBranchOf(repo)).toBe('main')
  })

  it.each(['develop', 'release/1.x'])('follows origin/HEAD to %s', (branch) => {
    const repo = createTempRepo({ withRemote: true })
    git(repo, 'push', '-q', 'origin', `main:refs/heads/${branch}`)
    git(repo, 'remote', 'set-head', 'origin', branch)
    expect(defaultBranchOf(repo)).toBe(branch)
  })
})
