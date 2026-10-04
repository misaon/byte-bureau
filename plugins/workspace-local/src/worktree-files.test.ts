import { readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordingLogger } from './testing/fixtures.js'
import { createTempRepo, tempDir } from './testing/temp-repo.js'
import { copyIgnoredFiles, ensureExcluded, onDisk } from './worktree-files.js'

describe(ensureExcluded, () => {
  it('writes every line when there is no exclude file yet, and adds only the missing ones to one there', () => {
    const file = path.join(tempDir('bb-exclude-'), 'info', 'exclude')
    ensureExcluded(file)
    const fresh = readFileSync(file, 'utf8')
    expect(fresh.split('\n')).toContain('.bytebureau/')
    writeFileSync(file, 'custom\n')
    ensureExcluded(file)
    expect(readFileSync(file, 'utf8')).toBe(`custom\n${fresh}`)
  })
})

describe(copyIgnoredFiles, () => {
  it('judges an entry by the real path of a project that is reached through a link', () => {
    const repo = createTempRepo()
    writeFileSync(path.join(repo, '.env'), 'SECRET=1\n')
    const link = path.join(tempDir('bb-link-'), 'project')
    symlinkSync(repo, link)
    const worktreePath = tempDir('bb-worktree-')
    copyIgnoredFiles({ projectPath: link, worktreePath }, ['.env'], recordingLogger().logger)
    expect(readFileSync(path.join(worktreePath, '.env'), 'utf8')).toBe('SECRET=1\n')
  })
})

// Throws whatever it is given, which is not always an Error
function fail(value: unknown): never {
  throw value
}

describe(onDisk, () => {
  it.each([
    ['an error by its message', new Error('EISDIR: nope'), 'copying failed: EISDIR: nope'],
    ['anything else by its text', 'plain text', 'copying failed: plain text'],
  ])('reports %s', (_name, thrown, message) => {
    expect(() => {
      onDisk('copying', () => fail(thrown))
    }).toThrow(message)
  })
})
