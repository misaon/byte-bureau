import { chmodSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { decodeServerInfo, type ServerInfo } from '@bytebureau/protocol'
import { writePrivateFile } from './private-file.js'

export const serverInfoPath = (home: string): string => path.join(home, 'server.json')

export const lockPath = (home: string): string => path.join(home, 'daemon.lock')

export type ServerRecord =
  | { readonly state: 'absent' }
  | { readonly state: 'alive'; readonly info: ServerInfo }
  // The daemon the file names is gone, or the file is no record at all
  | { readonly state: 'stale'; readonly info?: ServerInfo }

export type LockOutcome =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly pid: number }

const codeOf = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined

// Signal 0 tests the pid: a dead one throws ESRCH, a live one of another user EPERM; 0 and below would name a group of processes
export const isAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return codeOf(error) === 'EPERM'
  }
}

// The text of the file, or nothing when there is no file
const readIfThere = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

const removeIfThere = (file: string): void => {
  try {
    unlinkSync(file)
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') {
      throw error
    }
  }
}

const decoded = (text: string): ServerInfo | undefined => {
  try {
    const parsed: unknown = JSON.parse(text)
    return decodeServerInfo(parsed)
  } catch {
    return undefined
  }
}

export const readServerInfo = (home: string): ServerRecord => {
  const text = readIfThere(serverInfoPath(home))
  if (text === undefined) {
    return { state: 'absent' }
  }
  const info = decoded(text)
  if (info === undefined) {
    return { state: 'stale' }
  }
  return isAlive(info.pid) ? { state: 'alive', info } : { state: 'stale', info }
}

export const writeServerInfo = (home: string, info: ServerInfo): void => {
  writePrivateFile(serverInfoPath(home), `${JSON.stringify(info, undefined, 2)}\n`)
}

export const removeServerInfo = (home: string): void => {
  removeIfThere(serverInfoPath(home))
}

// The pid a lock names, if it names one
const holderOf = (home: string): number | undefined => {
  const text = readIfThere(lockPath(home))
  const pid = Number(text === undefined ? undefined : text.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

// The lock appears with the pid already in it: written aside, then linked into place, which fails when a lock is there
const tryLock = (home: string): boolean => {
  const draft = `${lockPath(home)}.${process.pid}`
  writeFileSync(draft, String(process.pid), { mode: 0o600 })
  chmodSync(draft, 0o600)
  try {
    linkSync(draft, lockPath(home))
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

// One daemon per home, decided atomically: a live holder is named, and a lock whose holder is gone, or that names none, is taken over
export const acquireLock = (home: string): LockOutcome => {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (tryLock(home)) {
    return { acquired: true }
  }
  const holder = holderOf(home)
  if (holder !== undefined && isAlive(holder)) {
    return { acquired: false, pid: holder }
  }
  removeIfThere(lockPath(home))
  return tryLock(home) ? { acquired: true } : { acquired: false, pid: holderOf(home) ?? 0 }
}

// Only the lock of this process is released: a lock another daemon has taken over is that daemon's
export const releaseLock = (home: string): void => {
  if (holderOf(home) === process.pid) {
    removeIfThere(lockPath(home))
  }
}
