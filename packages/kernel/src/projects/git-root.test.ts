import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTempRepo, git, tempDir } from '../testing/temp-repo.js'
import { defaultBranchOf, findGitRoot, isByteBureauWorktree } from './git-root.js'

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
})

describe(isByteBureauWorktree, () => {
  it('recognises the session marker file', () => {
    const repo = createTempRepo()
    expect(isByteBureauWorktree(repo)).toBe(false)
    writeFileSync(path.join(repo, '.bytebureau-session.json'), '{}')
    expect(isByteBureauWorktree(repo)).toBe(true)
  })
})

describe(defaultBranchOf, () => {
  it('uses origin/HEAD when present and main otherwise', () => {
    expect(defaultBranchOf(createTempRepo())).toBe('main')
    expect(defaultBranchOf(createTempRepo({ withRemote: true }))).toBe('main')
  })

  it('falls back to main in a repository without commits', () => {
    expect(defaultBranchOf(emptyRepo())).toBe('main')
  })

  it.each(['develop', 'release/1.x'])('follows origin/HEAD to %s', (branch) => {
    const repo = createTempRepo({ withRemote: true })
    git(repo, 'push', '-q', 'origin', `main:refs/heads/${branch}`)
    git(repo, 'remote', 'set-head', 'origin', branch)
    expect(defaultBranchOf(repo)).toBe(branch)
  })
})
