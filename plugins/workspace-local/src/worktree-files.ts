import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { Logger } from '@bytebureau/plugin-api'

const SESSION_MARKER = '.bytebureau-session.json'
// Worktrees live below .bytebureau/ and carry a marker file; git must report neither as untracked
const EXCLUDED = ['.bytebureau/', SESSION_MARKER]

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

export function hasSessionMarker(directory: string): boolean {
  return existsSync(path.join(directory, SESSION_MARKER))
}

export function writeSessionMarker(worktreePath: string, record: SessionRecord): void {
  writeFileSync(path.join(worktreePath, SESSION_MARKER), `${JSON.stringify(record, null, 2)}\n`)
}

// Adds what is missing to the exclude file and keeps what is there
export function ensureExcluded(excludeFile: string): void {
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
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

function classify(source: string, relative: string): Entry {
  if (!isInside(relative)) {
    return 'outside the project'
  }
  const info = statSync(source, { throwIfNoEntry: false })
  if (info === undefined) {
    return 'missing'
  }
  return info.isFile() ? 'copy' : 'not a file'
}

function copyOne(roots: Roots, file: string, logger: Logger): void {
  const source = path.resolve(roots.projectPath, file)
  const relative = path.relative(roots.projectPath, source)
  const entry = classify(source, relative)
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
