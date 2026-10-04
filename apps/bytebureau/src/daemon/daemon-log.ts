import { mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { stampOf } from './files.js'
import { isAlive, lockHolder } from './server-info.js'

export const daemonLogPath = (home: string): string => path.join(home, 'logs', 'daemon.log')

// A log written this recently belongs to a start under way, which keeps writing to it
const FRESH_MS = 2000

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
    renameSync(log, `${log}.1`)
  }
}
