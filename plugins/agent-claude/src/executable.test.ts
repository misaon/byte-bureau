import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveExecutable } from './executable.js'

// A directory with a file of the name in it, and one without, as two entries of PATH
const installed = (
  file: string,
): { readonly root: string; readonly bin: string; readonly empty: string } => {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-claude-exe-'))
  const bin = path.join(root, 'bin')
  const empty = path.join(root, 'empty')
  mkdirSync(bin)
  mkdirSync(empty)
  writeFileSync(path.join(bin, file), '#!/bin/sh\n', { mode: 0o755 })
  return { root, bin, empty }
}

// Entries of PATH whose claude no lookup may take, ahead of the one that holds the real one: a directory named relatively, a file it may not run, a directory of the name
const decoyPath = (root: string, bin: string): string => {
  const lent = path.join(root, 'lent')
  const plain = path.join(root, 'plain')
  const folder = path.join(root, 'folder', 'claude')
  mkdirSync(lent)
  mkdirSync(plain)
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(lent, 'claude'), '#!/bin/sh\n', { mode: 0o755 })
  writeFileSync(path.join(plain, 'claude'), '#!/bin/sh\n', { mode: 0o644 })
  return [path.relative(process.cwd(), lent), plain, path.dirname(folder), bin].join(path.delimiter)
}

describe(resolveExecutable, () => {
  it('finds the name in the first directory of PATH that has it', () => {
    expect.hasAssertions()
    const { root, bin, empty } = installed('claude')
    try {
      const env = { PATH: [empty, bin].join(path.delimiter) }
      expect(resolveExecutable('claude', env)).toBe(path.join(bin, 'claude'))
      expect(resolveExecutable('codex', env)).toBeUndefined()
      expect(resolveExecutable('claude', {})).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('takes a path as it is when it exists, a relative one from where the daemon runs', () => {
    expect.hasAssertions()
    const { root, bin } = installed('claude')
    try {
      const absolute = path.join(bin, 'claude')
      const relative = path.relative(process.cwd(), absolute)
      expect(resolveExecutable(absolute, {})).toBe(absolute)
      expect(resolveExecutable(relative, {})).toBe(absolute)
      expect(resolveExecutable(path.join(bin, 'missing'), { PATH: bin })).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('tries the suffixes of Windows commands on Windows', () => {
    expect.hasAssertions()
    const { root, bin } = installed('claude.cmd')
    try {
      expect(resolveExecutable('claude', { PATH: bin }, 'win32')).toBe(path.join(bin, 'claude.cmd'))
      expect(resolveExecutable('claude', { PATH: bin }, 'linux')).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('resolveExecutable and what no lookup may take', () => {
  it('skips a relative entry of PATH, a file it may not run and a directory of the name', () => {
    expect.hasAssertions()
    const { root, bin } = installed('claude')
    try {
      const env = { PATH: decoyPath(root, bin) }
      expect(resolveExecutable('claude', env)).toBe(path.join(bin, 'claude'))
      expect(resolveExecutable(path.join(root, 'plain', 'claude'), {})).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
