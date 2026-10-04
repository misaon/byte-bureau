import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

// The text of the file; nothing while there is no file
export const readIfPresent = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return undefined
    }
    throw error
  }
}

// The failure that came first is the one passed on
const discard = (draft: string): void => {
  try {
    rmSync(draft, { force: true })
  } catch {
    // Left behind: the next write of this process removes it before it begins
  }
}

// Created afresh, so neither a stale draft nor a link planted in its place receives the text, and narrowed to the user before it holds any
const writeDraft = (draft: string, text: string): void => {
  rmSync(draft, { force: true })
  const fd = openSync(draft, 'wx', 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

// Written beside the file in a draft of this process, flushed and moved into place, so a reader never sees half of it
// Two processes writing the same file never share a draft; a write that fails removes its draft and passes the failure on
export const writePrivate = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const draft = `${file}.${process.pid}.tmp`
  try {
    writeDraft(draft, text)
    renameSync(draft, file)
  } catch (error) {
    discard(draft)
    throw error
  }
}
