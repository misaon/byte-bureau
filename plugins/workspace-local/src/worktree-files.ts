import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Logger } from '@bytebureau/plugin-api'
import { WorkspaceError } from './errors.js'

const SESSION_MARKER = '.bytebureau-session.json'
// Worktrees live below .bytebureau/ and carry a marker file; git must report neither as untracked
const EXCLUDED = ['.bytebureau/', SESSION_MARKER]
const PLACED = /[\\/]\.bytebureau[\\/]worktrees[\\/][^\\/]+$/u

interface SessionRecord {
  readonly sessionId: string
  readonly projectPath: string
  readonly branch: string
  readonly baseRef: string
}

interface Roots {
  readonly projectPath: string
  readonly worktreePath: string
}

export function isDirectory(directory: string): boolean {
  return existsSync(directory) && statSync(directory).isDirectory()
}

// A session worktree has the marker, or sits where provision puts it: deleting the marker does not make it a project
export function isSessionWorktree(directory: string): boolean {
  return PLACED.test(directory) || existsSync(path.join(directory, SESSION_MARKER))
}

export function writeSessionMarker(worktreePath: string, record: SessionRecord): void {
  writeFileSync(path.join(worktreePath, SESSION_MARKER), `${JSON.stringify(record, null, 2)}\n`)
}

// File system failures come out as workspace errors, like git's
export function onDisk(what: string, work: () => void): void {
  try {
    work()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new WorkspaceError('fs_failed', `${what} failed: ${reason}`)
  }
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

// The exclude file as it is, or nothing when there is none yet: read at once, as a check before the read could go stale
const readOrEmpty = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return ''
    }
    throw error
  }
}

// Adds what is missing to the exclude file and keeps what is there
export function ensureExcluded(excludeFile: string): void {
  const current = readOrEmpty(excludeFile)
  const listed = new Set(current.split('\n'))
  const missing = EXCLUDED.filter((line) => !listed.has(line))
  if (missing.length > 0) {
    mkdirSync(path.dirname(excludeFile), { recursive: true })
    const separator = current === '' || current.endsWith('\n') ? '' : '\n'
    appendFileSync(excludeFile, `${separator}${missing.join('\n')}\n`)
  }
}

type Entry = 'copy' | 'missing' | 'not a file' | 'outside the project'

// A path that climbs out of the project, or names the project itself, is not an entry of it
function isInside(relative: string): boolean {
  const climbs = relative === '..' || relative.startsWith(`..${path.sep}`)
  return relative !== '' && !climbs && !path.isAbsolute(relative)
}

// Links are followed: what an entry resolves to has to lie inside the project as well
function classify(root: string, source: string, relative: string): Entry {
  if (!isInside(relative)) {
    return 'outside the project'
  }
  if (!existsSync(source)) {
    return 'missing'
  }
  if (!isInside(path.relative(realpathSync(root), realpathSync(source)))) {
    return 'outside the project'
  }
  return statSync(source).isFile() ? 'copy' : 'not a file'
}

function copyOne(roots: Roots, file: string, logger: Logger): void {
  const source = path.resolve(roots.projectPath, file)
  const relative = path.relative(roots.projectPath, source)
  const entry = classify(roots.projectPath, source, relative)
  if (entry === 'copy') {
    const target = path.join(roots.worktreePath, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(source, target)
  } else if (entry !== 'missing') {
    logger.warn('skipping a copyIgnored entry', { file, reason: entry })
  }
}

// Files the project keeps out of git, such as .env, go from the main checkout into the worktree
export function copyIgnoredFiles(roots: Roots, files: readonly string[], logger: Logger): void {
  for (const file of files) {
    copyOne(roots, file, logger)
  }
}
