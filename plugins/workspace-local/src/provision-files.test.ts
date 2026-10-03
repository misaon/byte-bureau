import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SESSION_ID,
  createRuntime,
  failingSpawner,
  readJson,
  recordingLogger,
  workspaceSpec,
} from './testing/fixtures.js'
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

// A temporary directory outside any project, with a secret file in it
function outsideWithSecret(): { readonly dir: string; readonly secret: string } {
  const dir = tempDir('bb-outside-')
  const secret = path.join(dir, 'secret.txt')
  writeFileSync(secret, 'secret\n')
  return { dir, secret }
}

// Entries that point out of the project by relative and by absolute path, and one that is a directory
function escapingEntries(repo: string): { outside: string; copyIgnored: string[] } {
  const { dir, secret } = outsideWithSecret()
  mkdirSync(path.join(repo, 'config'))
  const relative = path.join('..', path.basename(dir), path.basename(secret))
  return { outside: dir, copyIgnored: [relative, secret, 'config'] }
}

// A project with links to something outside it, a link to something inside it and a plain file
function repoWithLinks(): string {
  const repo = createTempRepo()
  const { dir, secret } = outsideWithSecret()
  symlinkSync(secret, path.join(repo, 'leak.env'))
  symlinkSync(dir, path.join(repo, 'linked'))
  mkdirSync(path.join(repo, 'config'))
  writeFileSync(path.join(repo, 'config', 'shared.env'), 'SHARED=1\n')
  symlinkSync(path.join('config', 'shared.env'), path.join(repo, '.env'))
  return repo
}

// The base branch holds a directory where the main checkout keeps a file
function repoWithClashingBase(): string {
  const repo = createTempRepo()
  git(repo, 'checkout', '-q', '-b', 'clash')
  mkdirSync(path.join(repo, 'scratch'))
  writeFileSync(path.join(repo, 'scratch', 'tracked.txt'), 'x\n')
  git(repo, 'add', 'scratch')
  git(repo, 'commit', '-q', '-m', 'directory')
  git(repo, 'checkout', '-q', 'main')
  writeFileSync(path.join(repo, 'scratch'), 'a file\n')
  return repo
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
    const handle = await createRuntime().provision(workspaceSpec(repo, { copyIgnored, logger }))
    const beside = path.join(handle.path, '..', path.basename(outside))
    expect(existsSync(beside)).toBe(false)
    expect(existsSync(path.join(handle.path, 'config'))).toBe(false)
    expect(existsSync(path.join(handle.path, outside))).toBe(false)
    expect(entries.filter((entry) => entry.level === 'warn')).toHaveLength(3)
  })
})

describe('symlinked entries', () => {
  it('skips a link that leads out of the project, also through a linked directory', async () => {
    expect.hasAssertions()
    const { logger, entries } = recordingLogger()
    const copyIgnored = ['leak.env', 'linked/secret.txt']
    const spec = workspaceSpec(repoWithLinks(), { copyIgnored, logger })
    const handle = await createRuntime().provision(spec)
    expect(existsSync(path.join(handle.path, 'leak.env'))).toBe(false)
    expect(existsSync(path.join(handle.path, 'linked'))).toBe(false)
    expect(entries.filter((entry) => entry.level === 'warn')).toHaveLength(2)
  })

  it('copies the content of a link that stays inside the project to the path of the entry', async () => {
    expect.hasAssertions()
    const spec = workspaceSpec(repoWithLinks(), { copyIgnored: ['.env'] })
    const handle = await createRuntime().provision(spec)
    expect(readFileSync(path.join(handle.path, '.env'), 'utf8')).toBe('SHARED=1\n')
    expect(existsSync(path.join(handle.path, 'config'))).toBe(false)
  })

  it('skips an entry that runs through a file without a warning', async () => {
    expect.hasAssertions()
    const { logger, entries } = recordingLogger()
    const spec = workspaceSpec(createTempRepo(), { copyIgnored: ['README.md/x'], logger })
    await expect(createRuntime().provision(spec)).resolves.toMatchObject({ branch: 'bb/add-hello' })
    expect(entries.filter((entry) => entry.level === 'warn')).toStrictEqual([])
  })
})

describe('a provision that fails halfway', () => {
  it('takes back the worktree and the branch and reports the file system error', async () => {
    expect.hasAssertions()
    const repo = repoWithClashingBase()
    const spec = workspaceSpec(repo, { baseBranch: 'clash', copyIgnored: ['scratch'] })
    await expect(createRuntime().provision(spec)).rejects.toMatchObject({ code: 'fs_failed' })
    expect(existsSync(path.join(repo, '.bytebureau', 'worktrees', SESSION_ID))).toBe(false)
    expect(git(repo, 'branch', '--list', 'bb/add-hello')).toBe('')
    expect(git(repo, 'worktree', 'list')).not.toContain('.bytebureau')
  })

  it('reports the original error and says so when it cannot take the worktree back', async () => {
    expect.hasAssertions()
    const { logger, entries } = recordingLogger()
    const runtime = createRuntime(failingSpawner('worktree remove', 'branch -D'))
    const spec = workspaceSpec(repoWithClashingBase(), {
      baseBranch: 'clash',
      copyIgnored: ['scratch'],
      logger,
    })
    await expect(runtime.provision(spec)).rejects.toMatchObject({ code: 'fs_failed' })
    expect(entries.filter((entry) => entry.level === 'warn')).toHaveLength(1)
  })

  it('creates nothing when the exclude list cannot be updated', async () => {
    expect.hasAssertions()
    const repo = createTempRepo()
    const exclude = path.join(repo, '.git', 'info', 'exclude')
    rmSync(exclude)
    mkdirSync(exclude)
    await expect(createRuntime().provision(workspaceSpec(repo))).rejects.toMatchObject({
      code: 'fs_failed',
    })
    expect(existsSync(path.join(repo, '.bytebureau'))).toBe(false)
    expect(git(repo, 'branch', '--list', 'bb/add-hello')).toBe('')
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
