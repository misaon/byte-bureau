import { mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { codeOf, stampOf } from './files.js'
import { isAlive, lockHolder } from './server-info.js'

export const daemonLogPath = (home: string): string => path.join(home, 'logs', 'daemon.log')

// A log written this recently belongs to a start under way, which keeps writing to it
const FRESH_MS = 2000

// A start beside this one may have moved the log since it was looked at: then it is rotated already
const rotated = (log: string): void => {
  try {
    renameSync(log, `${log}.1`)
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') {
      throw error
    }
  }
}

/**
 * The log of the previous run becomes daemon.log.1 when the next daemon starts, so the logs keep two runs at most
 * (until the rotating sink of the logging). Never while a live process holds the lock, nor when the log was written a
 * moment ago, as by a start under way: that daemon goes on writing to the file it was given.
 */
export const rotateDaemonLog = (home: string): void => {
  const log = daemonLogPath(home)
  mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 })
  const holder = lockHolder(home)
  const stamp = stampOf(log)
  if (stamp === undefined || (holder !== undefined && isAlive(holder))) {
    return
  }
  if (Date.now() - stamp.mtimeMs >= FRESH_MS) {
    rotated(log)
  }
}
