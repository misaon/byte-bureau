import { utimesSync, writeFileSync } from 'node:fs'
import { processStartedAt } from '../daemon/process-start.js'
import { lockPath } from '../daemon/server-info.js'
import { startDaemonProcess, type DaemonProcess } from './daemon.js'
import { testHome } from './temp-repo.js'

const AN_HOUR = 3_600_000

/**
 * The lock of the home made to read the time given before its holder started, or before now where the platform cannot
 * tell when it did: as a clock stepped since the lock was written shows it, or a lock that a crash or a reboot left.
 */
export async function lockReadBefore(home: string, pid: number, beforeMs: number): Promise<void> {
  const started = await processStartedAt(pid)
  const written = new Date((started ?? Date.now()) - beforeMs)
  utimesSync(lockPath(home), written, written)
}

// A lock left from before a crash or a reboot, naming a process that got the pid since: written an hour before it started
export async function oldLock(home: string, pid: number): Promise<void> {
  writeFileSync(lockPath(home), String(pid))
  await lockReadBefore(home, pid, AN_HOUR)
}

// A daemon of a home of its own whose lock reads two seconds older than its start, as a clock stepped since shows it
export async function daemonOfSkewedLock(): Promise<{
  readonly home: string
  readonly daemon: DaemonProcess
}> {
  const home = testHome()
  const daemon = await startDaemonProcess(home)
  await lockReadBefore(home, daemon.info.pid, 2000)
  return { home, daemon }
}

// When a process started, for a judgement on a platform that cannot tell
export const unknownStart = async (): Promise<number | undefined> => {
  await Promise.resolve()
  return undefined
}

// What a start or a stop says of a daemon of the home that holds the lock without answering, and the way out
export const silentLine = (home: string, pid: number): string =>
  `A daemon of this home (pid ${pid}) holds the lock but does not answer; it may be stopped or busy, and if it is not a daemon of this home, delete ${lockPath(home)}`
