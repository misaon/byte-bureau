import {
  chmodSync,
  linkSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

export const codeOf = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined

// The text of the file, or nothing when there is no file
export const readIfThere = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

export const removeIfThere = (file: string): void => {
  try {
    unlinkSync(file)
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') {
      throw error
    }
  }
}

// Which file a path names, and since when: a file written again under the same name is another file
export interface FileStamp {
  readonly ino: number
  readonly mtimeMs: number
}

export const stampOf = (file: string): FileStamp | undefined => {
  try {
    const { ino, mtimeMs } = statSync(file)
    return { ino, mtimeMs }
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

// The pid a file names, if it names one
export const pidIn = (file: string): number | undefined => {
  const text = readIfThere(file)
  const pid = Number(text === undefined ? undefined : text.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

// The file appears with the pid of this process already in it: written aside, then linked into place, which fails when a file is there
export const linkedWithPid = (file: string): boolean => {
  const draft = `${file}.${process.pid}`
  writeFileSync(draft, String(process.pid), { mode: 0o600 })
  chmodSync(draft, 0o600)
  try {
    linkSync(draft, file)
    return true
  } catch (error) {
    if (codeOf(error) === 'EEXIST') {
      return false
    }
    throw error
  } finally {
    unlinkSync(draft)
  }
}

// False when another remover moved the file first
const movedAside = (file: string, aside: string): boolean => {
  try {
    renameSync(file, aside)
    return true
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return false
    }
    throw error
  }
}

// Back where it was, never over a file made since
const putBack = (aside: string, file: string): void => {
  try {
    linkSync(aside, file)
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') {
      throw error
    }
  } finally {
    unlinkSync(aside)
  }
}

// The same file: a file made since may get a freed inode again, never the same time of change as well
const isSame = (stamp: FileStamp | undefined, judged: FileStamp): boolean =>
  stamp !== undefined && stamp.ino === judged.ino && stamp.mtimeMs === judged.mtimeMs

/**
 * Removes the file only if it still is the one that was judged, as its inode and its time of change tell.
 * A rename moves it aside first, which only one remover can win; a file written since the judgement goes back where it was.
 */
export const removeIfSame = (file: string, judged: FileStamp): boolean => {
  const aside = `${file}.${process.pid}.stale`
  if (!movedAside(file, aside)) {
    return false
  }
  if (isSame(stampOf(aside), judged)) {
    unlinkSync(aside)
    return true
  }
  putBack(aside, file)
  return false
}
