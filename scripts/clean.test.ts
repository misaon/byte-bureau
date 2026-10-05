import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import {
  assertRemovable,
  assertRepository,
  cleanup,
  formatBytes,
  isStale,
  parseArgs,
  planRemovals,
  sizeOf,
  totalBytes,
  type CleanOptions,
} from './clean.js'

const DAY_MS = 86_400_000
const DEFAULTS: CleanOptions = { cacheDays: 7, cacheOnly: false, dryRun: false }
const MANIFEST = JSON.stringify({ name: 'byte-bureau', workspaces: { packages: ['apps/*'] } })
const CACHE = '.turbo/cache'
const OLD_DAYS = 30

// The clean removes these, in the order it names them, and nothing else
const REMOVED = {
  'dist/bytebureau-0.1.0-linux-x64': 100,
  'coverage/lcov.info': 20,
  'apps/bytebureau/dist/bytebureau-0.1.0-linux-x64': 300,
  'apps/docs/dist/index.html': 40,
  'apps/docs/.astro/data-store.json': 5,
  'apps/docs/src/nested/site.tsbuildinfo': 2,
  'packages/kernel/tsconfig.tsbuildinfo': 7,
  'tsconfig.tsbuildinfo': 3,
}
const KEPT = {
  'packages/kernel/src/index.ts': 9,
  'node_modules/dep/dist/index.js': 1,
  'node_modules/dep/dep.tsbuildinfo': 1,
  'apps/docs/node_modules/dep/dep.tsbuildinfo': 1,
  '.git/x.tsbuildinfo': 1,
  '.superpowers/sdd/dist/report.md': 1,
  'tools/gen/dist/out.js': 1,
}
const LABELS = [
  'dist',
  'coverage',
  'apps/bytebureau/dist',
  'apps/docs/dist',
  'apps/docs/.astro',
  'apps/docs/src/nested/site.tsbuildinfo',
  'packages/kernel/tsconfig.tsbuildinfo',
  'tsconfig.tsbuildinfo',
  `${CACHE}/aaaaaaaaaaaaaaaa`,
  `${CACHE}/dddddddddddddddd`,
]

const entry = (hash: string): Record<string, number> => ({
  [`${CACHE}/${hash}.tar.zst`]: 1000,
  [`${CACHE}/${hash}-meta.json`]: 10,
  [`${CACHE}/${hash}-manifest.json`]: 20,
})

function tempDir(): string {
  const made = mkdtempSync(path.join(tmpdir(), 'bytebureau-clean-'))
  const dir = realpathSync(made)
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function write(root: string, sizes: Readonly<Record<string, number>>): void {
  for (const [file, size] of Object.entries(sizes)) {
    const target = path.join(root, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, 'x'.repeat(size))
  }
}

const filesUnder = (root: string): string[] =>
  readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((name) => lstatSync(path.join(root, name)).isFile())
    .toSorted()

function aged(root: string, files: readonly string[]): void {
  const seconds = (Date.now() - OLD_DAYS * DAY_MS) / 1000
  for (const file of files) {
    utimesSync(path.join(root, file), seconds, seconds)
  }
}

// Entry aaaa is old whole, bbbb new whole, cccc has only an old tarball, dddd is one old file; notes.txt is no entry
function repository(): string {
  const root = tempDir()
  const hashes = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc']
  const entries = Object.fromEntries(hashes.flatMap((hash) => Object.entries(entry(hash))))
  write(root, { ...REMOVED, ...KEPT, ...entries })
  write(root, { [`${CACHE}/dddddddddddddddd-meta.json`]: 10, [`${CACHE}/notes.txt`]: 4 })
  writeFileSync(path.join(root, 'package.json'), MANIFEST)
  const old = [`${CACHE}/cccccccccccccccc.tar.zst`, `${CACHE}/dddddddddddddddd-meta.json`]
  aged(root, [...Object.keys(entry('aaaaaaaaaaaaaaaa')), ...old, `${CACHE}/notes.txt`])
  return root
}

function said(root: string, options: CleanOptions): { bytes: number; lines: string[] } {
  const lines: string[] = []
  const bytes = cleanup(root, options, (line) => {
    lines.push(line)
  })
  return { bytes, lines }
}

describe(parseArgs, () => {
  it('prunes the cache after 7 days and removes the rest, unless told otherwise', () => {
    expect(parseArgs([])).toStrictEqual(DEFAULTS)
    expect(parseArgs(['--cache-only', '--dry-run', '--cache-days', '3'])).toStrictEqual({
      cacheDays: 3,
      cacheOnly: true,
      dryRun: true,
    })
  })

  it('rejects an unknown argument and a day count that is not a whole number', () => {
    expect.hasAssertions()
    expect(() => parseArgs(['--fast'])).toThrow('unknown argument: --fast')
    for (const args of [['--cache-days'], ['--cache-days', 'x'], ['--cache-days', '1.5']]) {
      expect(() => parseArgs(args)).toThrow('--cache-days takes a whole number of days')
    }
  })
})

describe(isStale, () => {
  it('is true for a modification older than the days and false for one exactly that old', () => {
    const now = 10 * DAY_MS
    const times = [now - 8 * DAY_MS, now - 7 * DAY_MS - 1, now - 7 * DAY_MS, now - DAY_MS, now]
    expect(times.map((time) => isStale(time, now, 7))).toStrictEqual([
      true,
      true,
      false,
      false,
      false,
    ])
    expect(isStale(now - 1, now, 0)).toBe(true)
  })
})

describe('the byte count', () => {
  it('adds the bytes of the files below a directory and counts a link as itself', () => {
    const dir = tempDir()
    write(dir, { 'a/one': 100, 'a/b/two': 20, 'a/b/c/three': 3 })
    const link = path.join(dir, 'a', 'link')
    symlinkSync(dir, link)
    expect(sizeOf(path.join(dir, 'a', 'b'))).toBe(23)
    expect(sizeOf(path.join(dir, 'a'))).toBe(123 + lstatSync(link).size)
  })

  it('is told in bytes, KiB, MiB, GiB and TiB with one decimal', () => {
    const sizes = [0, 1023, 1024, 1536, 1024 ** 2, 5.5 * 1024 ** 2, 3 * 1024 ** 3, 2 * 1024 ** 4]
    const told = ['0 B', '1023 B', '1.0 KiB', '1.5 KiB', '1.0 MiB', '5.5 MiB', '3.0 GiB', '2.0 TiB']
    expect(sizes.map((bytes) => formatBytes(bytes))).toStrictEqual(told)
  })
})

describe('the guards', () => {
  it('take this repository, and refuse a directory with no, broken, other or workspace-less manifest', () => {
    expect.hasAssertions()
    expect(() => {
      assertRepository(path.join(import.meta.dirname, '..'))
    }).not.toThrow()
    expect(() => {
      assertRepository(tempDir())
    }).toThrow('is not the byte-bureau repository')
    for (const manifest of ['{', '{"name":"x","workspaces":[]}', '{"name":"byte-bureau"}']) {
      const dir = tempDir()
      writeFileSync(path.join(dir, 'package.json'), manifest)
      expect(() => {
        assertRepository(dir)
      }).toThrow('is not the byte-bureau repository')
    }
  })

  it('take a path in the root, and refuse the root, the outside and the protected directories', () => {
    expect.hasAssertions()
    const root = repository()
    expect(() => {
      assertRemovable(root, path.join(root, 'apps', 'docs', 'dist'))
    }).not.toThrow()
    const refused = [
      root,
      tempDir(),
      'node_modules/dep/dist',
      '.git/x.tsbuildinfo',
      '.superpowers/sdd',
    ]
    for (const target of refused) {
      expect(() => {
        assertRemovable(root, path.resolve(root, target))
      }).toThrow('refusing to remove')
    }
  })
})

describe(planRemovals, () => {
  it('lists the build outputs, the *.tsbuildinfo files and the stale cache entries, with their bytes', () => {
    const plan = planRemovals(repository(), DEFAULTS, Date.now())
    expect(plan.map((removal) => removal.label)).toStrictEqual(LABELS)
    expect(plan.map((removal) => removal.bytes)).toStrictEqual([
      100, 20, 300, 40, 5, 2, 7, 3, 1030, 10,
    ])
    expect(totalBytes(plan)).toBe(1517)
  })

  it('prunes a cache entry whole by its newest file, for 0 days every one, and no other file', () => {
    const options = { ...DEFAULTS, cacheOnly: true }
    const root = repository()
    const entries = planRemovals(root, options, Date.now()).map((removal) => removal.paths)
    expect(entries.map((files) => files.map((file) => path.basename(file)))).toStrictEqual([
      ['aaaaaaaaaaaaaaaa-manifest.json', 'aaaaaaaaaaaaaaaa-meta.json', 'aaaaaaaaaaaaaaaa.tar.zst'],
      ['dddddddddddddddd-meta.json'],
    ])
    expect(planRemovals(root, { ...options, cacheDays: 0 }, Date.now() + 1000)).toHaveLength(4)
  })

  it('refuses it all when a path resolves outside the root through a link', () => {
    expect.hasAssertions()
    const root = repository()
    const outside = tempDir()
    write(outside, { 'docs/dist/index.html': 1 })
    rmSync(path.join(root, 'apps'), { recursive: true })
    symlinkSync(outside, path.join(root, 'apps'))
    expect(() => planRemovals(root, DEFAULTS, Date.now())).toThrow('refusing to remove')
    expect(filesUnder(outside)).toStrictEqual(['docs/dist/index.html'])
  })
})

describe(cleanup, () => {
  it('names what it would remove and removes nothing on a dry run', () => {
    const root = repository()
    const before = filesUnder(root)
    const { bytes, lines } = said(root, { ...DEFAULTS, dryRun: true })
    expect(lines.slice(0, -1).map((line) => line.replace(/ \(.*$/u, ''))).toStrictEqual(
      LABELS.map((label) => `would remove ${label}`),
    )
    expect(lines.at(-1)).toBe('would free 1.5 KiB (1517 bytes) in 10 items')
    expect(lines).toContain(`would remove ${CACHE}/aaaaaaaaaaaaaaaa (1.0 KiB, 3 files)`)
    expect(bytes).toBe(1517)
    expect(filesUnder(root)).toStrictEqual(before)
  })

  it('removes what it names, as it names it, and nothing else', () => {
    const root = repository()
    const kept = ['package.json', `${CACHE}/notes.txt`, ...Object.keys(KEPT)]
    const entries = ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc'].flatMap((hash) =>
      Object.keys(entry(hash)),
    )
    const { bytes, lines } = said(root, DEFAULTS)
    expect(bytes).toBe(1517)
    expect(lines).toContain('removed apps/docs/dist (40 B)')
    expect(lines.at(-1)).toBe('freed 1.5 KiB (1517 bytes) in 10 items')
    expect(filesUnder(root)).toStrictEqual([...kept, ...entries].toSorted())
  })

  it('removes a link and never what it points to', () => {
    const root = repository()
    const outside = tempDir()
    write(outside, { 'real/keep': 1 })
    rmSync(path.join(root, 'dist'), { recursive: true })
    symlinkSync(path.join(outside, 'real'), path.join(root, 'dist'))
    said(root, DEFAULTS)
    expect(lstatSync(path.join(root, 'dist'), { throwIfNoEntry: false })).toBeUndefined()
    expect(filesUnder(outside)).toStrictEqual(['real/keep'])
  })

  it('says so when there is nothing to remove, and refuses another directory', () => {
    expect.hasAssertions()
    const empty = tempDir()
    writeFileSync(path.join(empty, 'package.json'), MANIFEST)
    expect(said(empty, DEFAULTS)).toStrictEqual({ bytes: 0, lines: ['nothing to remove'] })
    const other = tempDir()
    write(other, { 'dist/keep': 1 })
    expect(() => said(other, DEFAULTS)).toThrow('is not the byte-bureau repository')
    expect(filesUnder(other)).toStrictEqual(['dist/keep'])
  })
})
