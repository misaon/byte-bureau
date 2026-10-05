#!/usr/bin/env bun
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'

export interface CleanOptions {
  readonly cacheDays: number
  readonly cacheOnly: boolean
  readonly dryRun: boolean
}

export interface Removal {
  // What the report names: a path under the root, or a cache entry by its hash
  readonly label: string
  readonly paths: readonly string[]
  readonly bytes: number
}

interface CacheEntry {
  readonly hash: string
  readonly files: readonly string[]
  readonly modified: number
}

const ROOT = path.join(import.meta.dirname, '..')
const REPOSITORY = 'byte-bureau'
const DEFAULT_CACHE_DAYS = 7
const DAY_MS = 86_400_000
const HASH_LENGTH = 16
const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const
// Where the build outputs of the root and of every workspace go; all of them are in .gitignore
const GENERATED = ['dist', 'coverage', '.astro'] as const
const WORKSPACE_PARENTS = ['apps', 'packages', 'plugins'] as const
// Never removed, whatever the path says
const PROTECTED = new Set(['node_modules', '.git', '.superpowers'])
// The search for *.tsbuildinfo skips the cache too: its files are entries and nothing else
const NOT_SEARCHED = new Set([...PROTECTED, '.turbo'])
// A file of a cache entry: the 16 hex digits of the task hash, then .tar.zst, -meta.json or -manifest.json
const CACHE_FILE = /^[0-9a-f]{16}[.-]/u
const USAGE = 'usage: clean.ts [--cache-only] [--cache-days <n>] [--dry-run]'

const present = (target: string): boolean =>
  lstatSync(target, { throwIfNoEntry: false }) !== undefined

function daysOf(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new Error(`--cache-days takes a whole number of days, not ${value ?? 'nothing'}`)
  }
  return Number(value)
}

// A flag that takes a value consumes it from the arguments that follow it
function applyFlag(options: CleanOptions, arg: string, rest: string[]): CleanOptions {
  switch (arg) {
    case '--cache-only': {
      return { ...options, cacheOnly: true }
    }
    case '--dry-run': {
      return { ...options, dryRun: true }
    }
    case '--cache-days': {
      return { ...options, cacheDays: daysOf(rest.shift()) }
    }
    default: {
      throw new Error(`unknown argument: ${arg}\n${USAGE}`)
    }
  }
}

export function parseArgs(argv: readonly string[]): CleanOptions {
  let options: CleanOptions = { cacheDays: DEFAULT_CACHE_DAYS, cacheOnly: false, dryRun: false }
  const rest = [...argv]
  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    options = applyFlag(options, arg, rest)
  }
  return options
}

function manifestOf(root: string): unknown {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

// The directory is the repository when its manifest names it and declares the workspaces
export function assertRepository(root: string): void {
  const manifest = manifestOf(root)
  const ours =
    typeof manifest === 'object' &&
    manifest !== null &&
    'name' in manifest &&
    manifest.name === REPOSITORY &&
    'workspaces' in manifest
  if (!ours) {
    throw new Error(`refusing to clean ${root}: it is not the ${REPOSITORY} repository`)
  }
}

// A path inside the root once the links of its parents are resolved, and in none of the protected directories
export function assertRemovable(root: string, target: string): void {
  const resolved = path.join(realpathSync(path.dirname(target)), path.basename(target))
  const relative = path.relative(realpathSync(root), resolved)
  const segments = relative.split(path.sep)
  const outside = relative === '' || path.isAbsolute(relative) || segments[0] === '..'
  if (outside || segments.some((segment) => PROTECTED.has(segment))) {
    throw new Error(`refusing to remove ${target}: outside ${root} or in a protected directory`)
  }
}

// The bytes of the files under the target, a link counting as itself and never followed
export function sizeOf(target: string): number {
  const stat = lstatSync(target)
  if (!stat.isDirectory()) {
    return stat.size
  }
  return readdirSync(target).reduce((sum, name) => sum + sizeOf(path.join(target, name)), 0)
}

// An entry is stale once its newest file is older than the days: exactly that old it stays
export function isStale(modified: number, now: number, days: number): boolean {
  return modified < now - days * DAY_MS
}

function removalOf(label: string, paths: readonly string[]): Removal {
  return { label, paths, bytes: paths.reduce((sum, target) => sum + sizeOf(target), 0) }
}

function workspaceDirs(root: string): string[] {
  return WORKSPACE_PARENTS.flatMap((parent) => {
    const parentDir = path.join(root, parent)
    if (!present(parentDir)) {
      return []
    }
    return readdirSync(parentDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parentDir, entry.name))
      .toSorted()
  })
}

function generatedDirs(bases: readonly string[]): string[] {
  return bases
    .flatMap((base) => GENERATED.map((name) => path.join(base, name)))
    .filter((target) => present(target))
}

// The files of a directory, and with deep the files of the directories below it as well
function tsBuildInfoIn(dir: string, skip: ReadonlySet<string>, deep: boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const entered = deep && !NOT_SEARCHED.has(entry.name) && !skip.has(full)
      return entered ? tsBuildInfoIn(full, skip, deep) : []
    }
    return entry.isFile() && entry.name.endsWith('.tsbuildinfo') ? [full] : []
  })
}

// The root and every workspace; the other directories of the repository are left alone
function generatedRemovals(root: string): Removal[] {
  const workspaces = workspaceDirs(root)
  const dirs = generatedDirs([root, ...workspaces])
  const skip = new Set(dirs)
  const files = [
    ...tsBuildInfoIn(root, skip, false),
    ...workspaces.flatMap((workspace) => tsBuildInfoIn(workspace, skip, true)),
  ]
  return [...dirs, ...files.toSorted()].map((target) =>
    removalOf(path.relative(root, target), [target]),
  )
}

function cacheEntries(cacheDir: string): CacheEntry[] {
  if (!present(cacheDir)) {
    return []
  }
  const names = readdirSync(cacheDir)
    .filter((name) => CACHE_FILE.test(name))
    .toSorted()
  return [...Map.groupBy(names, (name) => name.slice(0, HASH_LENGTH))].map(([hash, grouped]) => {
    const files = grouped.map((name) => path.join(cacheDir, name))
    return { hash, files, modified: Math.max(...files.map((file) => lstatSync(file).mtimeMs)) }
  })
}

function staleCacheRemovals(root: string, days: number, now: number): Removal[] {
  const cacheDir = path.join(root, '.turbo', 'cache')
  return cacheEntries(cacheDir)
    .filter((entry) => isStale(entry.modified, now, days))
    .map((entry) => removalOf(path.relative(root, path.join(cacheDir, entry.hash)), entry.files))
}

// Everything the options remove, checked before anything is: one path that is not removable refuses all
export function planRemovals(root: string, options: CleanOptions, now: number): Removal[] {
  const generated = options.cacheOnly ? [] : generatedRemovals(root)
  const plan = [...generated, ...staleCacheRemovals(root, options.cacheDays, now)]
  for (const target of plan.flatMap((removal) => removal.paths)) {
    assertRemovable(root, target)
  }
  return plan
}

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${UNITS[unit] ?? 'B'}`
}

export const totalBytes = (removals: readonly Removal[]): number =>
  removals.reduce((sum, removal) => sum + removal.bytes, 0)

function lineOf(removal: Removal, dryRun: boolean): string {
  const size = formatBytes(removal.bytes)
  const files = removal.paths.length > 1 ? `, ${removal.paths.length} files` : ''
  return `${dryRun ? 'would remove' : 'removed'} ${removal.label} (${size}${files})`
}

function summaryOf(removals: readonly Removal[], dryRun: boolean): string {
  if (removals.length === 0) {
    return 'nothing to remove'
  }
  const bytes = totalBytes(removals)
  const verb = dryRun ? 'would free' : 'freed'
  return `${verb} ${formatBytes(bytes)} (${bytes} bytes) in ${removals.length} items`
}

function removeAll(paths: readonly string[]): void {
  for (const target of paths) {
    rmSync(target, { recursive: true, force: true })
  }
}

// Says each path as it goes, then the total; returns the bytes freed, or the bytes that would be
export function cleanup(root: string, options: CleanOptions, say: (line: string) => void): number {
  assertRepository(root)
  const removals = planRemovals(root, options, Date.now())
  for (const removal of removals) {
    if (!options.dryRun) {
      removeAll(removal.paths)
    }
    say(lineOf(removal, options.dryRun))
  }
  say(summaryOf(removals, options.dryRun))
  return totalBytes(removals)
}

/* v8 ignore start */
if (import.meta.main) {
  try {
    cleanup(ROOT, parseArgs(Bun.argv.slice(2)), (line) => {
      console.log(line)
    })
  } catch (error) {
    console.error(`clean: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
