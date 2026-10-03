import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SESSION_ID,
  createRuntime,
  readJson,
  recordingLogger,
  workspaceSpec,
} from './testing/fixtures.js'
import { nodeSpawner } from './testing/node-spawner.js'
import { createTempRepo, git, tempDir } from './testing/temp-repo.js'

// A repository that ignores what a worktree is meant to receive, committed like a real project's
function repoIgnoring(...patterns: string[]): string {
  const repo = createTempRepo()
  writeFileSync(path.join(repo, '.gitignore'), `${patterns.join('\n')}\n`)
  git(repo, 'add', '.gitignore')
  git(repo, 'commit', '-q', '-m', 'ignore')
  return repo
}

// An ignored .env and an ignored file in a subdirectory
function repoWithIgnoredFiles(): string {
  const repo = repoIgnoring('.env', 'config/')
  mkdirSync(path.join(repo, 'config'))
  writeFileSync(path.join(repo, '.env'), 'SECRET=1\n')
  writeFileSync(path.join(repo, 'config', 'local.env'), 'MODE=dev\n')
  return repo
}

// Entries that point out of the project by relative and by absolute path, and one that is a directory
function escapingEntries(repo: string): { outside: string; copyIgnored: string[] } {
  const outside = tempDir('bb-outside-')
  writeFileSync(path.join(outside, 'secret.txt'), 'secret\n')
  mkdirSync(path.join(repo, 'config'))
  const relative = path.join('..', path.basename(outside), 'secret.txt')
  return { outside, copyIgnored: [relative, path.join(outside, 'secret.txt'), 'config'] }
}

describe('copying ignored files', () => {
  it('copies listed files, also from subdirectories, and skips the missing ones', async () => {
    expect.hasAssertions()
    const copyIgnored = ['.env', 'config/local.env', 'missing.txt']
    const spec = workspaceSpec(repoWithIgnoredFiles(), { copyIgnored })
    const handle = await createRuntime().provision(spec)
    expect(readFileSync(path.join(handle.path, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(readFileSync(path.join(handle.path, 'config', 'local.env'), 'utf8')).toBe('MODE=dev\n')
    expect(existsSync(path.join(handle.path, 'missing.txt'))).toBe(false)
    expect(git(handle.path, 'status', '--porcelain')).toBe('')
  })

  it('leaves out what is not a file inside the project and says so', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const { outside, copyIgnored } = escapingEntries(repo)
    const { logger, entries } = recordingLogger()
    const handle = await createRuntime(nodeSpawner, logger).provision(
      workspaceSpec(repo, { copyIgnored }),
    )
    const beside = path.join(handle.path, '..', path.basename(outside))
    expect(existsSync(beside)).toBe(false)
    expect(existsSync(path.join(handle.path, 'config'))).toBe(false)
    expect(existsSync(path.join(handle.path, outside))).toBe(false)
    expect(entries.filter((entry) => entry.level === 'warn')).toHaveLength(3)
  })
})

describe('session marker', () => {
  it('records the session in a file at the worktree root', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const handle = await createRuntime().provision(workspaceSpec(repo))
    expect(readJson(path.join(handle.path, '.bytebureau-session.json'))).toStrictEqual({
      sessionId: SESSION_ID,
      projectPath: repo,
      branch: 'bb/add-hello',
      baseRef: 'main',
    })
  })
})

describe('exclude list', () => {
  it('lists the worktrees and the marker once and keeps the entries already there', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const exclude = path.join(repo, '.git', 'info', 'exclude')
    writeFileSync(exclude, '*.log')
    const runtime = createRuntime()
    await runtime.provision(workspaceSpec(repo, { sessionId: 'one', branch: 'bb/one' }))
    await runtime.provision(workspaceSpec(repo, { sessionId: 'two', branch: 'bb/two' }))
    expect(readFileSync(exclude, 'utf8')).toBe('*.log\n.bytebureau/\n.bytebureau-session.json\n')
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('creates the exclude list when the repository has none', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    rmSync(path.join(repo, '.git', 'info'), { recursive: true })
    await createRuntime().provision(workspaceSpec(repo))
    const exclude = readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toBe('.bytebureau/\n.bytebureau-session.json\n')
  })

  it('goes into the main repository when the project is itself a linked worktree', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const linked = path.join(tempDir('bb-linked-'), 'checkout')
    git(repo, 'worktree', 'add', '-q', linked, '-b', 'feature')
    const handle = await createRuntime().provision(workspaceSpec(linked))
    expect(handle.path).toBe(path.join(linked, '.bytebureau', 'worktrees', SESSION_ID))
    expect(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.bytebureau/',
    )
    expect(git(linked, 'status', '--porcelain')).toBe('')
  })
})
