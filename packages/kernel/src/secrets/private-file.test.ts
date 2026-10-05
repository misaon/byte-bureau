import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { readIfPresent, writePrivate } from './private-file.js'

const modeOf = (file: string): number => statSync(file).mode % 0o1000

// A file of a fresh directory that the test removes when it is over
const fileIn = (name: string): string => path.join(tempDir('bb-private-'), name)

describe(writePrivate, () => {
  it('writes the text for the user alone and leaves no draft behind', () => {
    const file = fileIn('secrets.json')
    writePrivate(file, 'text')
    expect([readFileSync(file, 'utf8'), modeOf(file)]).toStrictEqual(['text', 0o600])
    expect(readdirSync(path.dirname(file))).toStrictEqual(['secrets.json'])
  })

  it('leaves the draft of another writer alone, and writes through no link planted at its own', () => {
    const file = fileIn('secrets.json')
    const target = path.join(path.dirname(file), 'target')
    writeFileSync(target, 'untouched')
    writeFileSync(`${file}.tmp`, 'theirs')
    symlinkSync(target, `${file}.${process.pid}.tmp`)
    writePrivate(file, 'secret')
    expect([readFileSync(target, 'utf8'), readFileSync(`${file}.tmp`, 'utf8')]).toStrictEqual([
      'untouched',
      'theirs',
    ])
    expect([lstatSync(file).isFile(), readFileSync(file, 'utf8'), modeOf(file)]).toStrictEqual([
      true,
      'secret',
      0o600,
    ])
  })

  it('removes its draft when the file cannot be replaced, and passes the failure on', () => {
    const file = fileIn('taken')
    mkdirSync(path.join(file, 'inside'), { recursive: true })
    expect(() => {
      writePrivate(file, 'text')
    }).toThrow(/EISDIR|ENOTEMPTY|EEXIST/u)
    expect(readdirSync(path.dirname(file))).toStrictEqual(['taken'])
  })
})

describe(readIfPresent, () => {
  it('reads the text of a file, and nothing where there is none', () => {
    const file = fileIn('record')
    expect(readIfPresent(file)).toBeUndefined()
    writeFileSync(file, 'file\n')
    expect(readIfPresent(file)).toBe('file\n')
  })

  it('passes on a failure other than a missing file', () => {
    const directory = path.dirname(fileIn('record'))
    expect(() => readIfPresent(directory)).toThrow(/EISDIR/u)
  })
})
