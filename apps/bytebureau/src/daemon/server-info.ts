import path from 'node:path'
import { decodeServerInfo, type ServerInfo } from '@bytebureau/protocol'
import { codeOf, pidIn, readIfThere, removeIfSame, removeIfThere, stampOf } from './files.js'
import { writePrivateFile } from './private-file.js'

export const serverInfoPath = (home: string): string => path.join(home, 'server.json')

export const lockPath = (home: string): string => path.join(home, 'daemon.lock')

// The pid the lock of the home names, if it names one
export const lockHolder = (home: string): number | undefined => pidIn(lockPath(home))

export type ServerRecord =
  | { readonly state: 'absent' }
  | { readonly state: 'alive'; readonly info: ServerInfo }
  // The daemon the file names is gone, or the file is no record at all
  | { readonly state: 'stale'; readonly info?: ServerInfo }

// What signal 0 tells of a pid: a dead one throws ESRCH, a live one of another user EPERM, which this user cannot look into
export type PidState = 'dead' | 'alive' | 'foreign'

// Pid 0 and below would name a group of processes
export const pidState = (pid: number): PidState => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return 'dead'
  }
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return codeOf(error) === 'EPERM' ? 'foreign' : 'dead'
  }
}

export const isAlive = (pid: number): boolean => pidState(pid) !== 'dead'

const decoded = (text: string): ServerInfo | undefined => {
  try {
    const parsed: unknown = JSON.parse(text)
    return decodeServerInfo(parsed)
  } catch {
    return undefined
  }
}

const recordIn = (text: string | undefined): ServerRecord => {
  if (text === undefined) {
    return { state: 'absent' }
  }
  const info = decoded(text)
  if (info === undefined) {
    return { state: 'stale' }
  }
  return isAlive(info.pid) ? { state: 'alive', info } : { state: 'stale', info }
}

export const readServerInfo = (home: string): ServerRecord =>
  recordIn(readIfThere(serverInfoPath(home)))

export const writeServerInfo = (home: string, info: ServerInfo): void => {
  writePrivateFile(serverInfoPath(home), `${JSON.stringify(info, undefined, 2)}\n`)
}

export const removeServerInfo = (home: string): void => {
  removeIfThere(serverInfoPath(home))
}

/**
 * Removes server.json if the record it holds now passes the check, and only that record: one a daemon has written since
 * the file was read stays. Read, judged and removed as one file, by its inode.
 */
export const removeServerInfoIf = (
  home: string,
  check: (record: ServerRecord) => boolean,
): boolean => {
  const file = serverInfoPath(home)
  const stamp = stampOf(file)
  if (stamp === undefined || !check(recordIn(readIfThere(file)))) {
    return false
  }
  return removeIfSame(file, stamp)
}
