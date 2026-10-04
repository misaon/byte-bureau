import { setTimeout as sleep } from 'node:timers/promises'
import { JUDGING, type Judging } from './lock-holder.js'
import { clearStaleLock } from './lock.js'
import { isAlive, readServerInfo, removeServerInfoIf, type ServerRecord } from './server-info.js'
import { daemonAnswers, runningDaemon } from './wait.js'

export type StopOutcome =
  | { readonly outcome: 'stopped'; readonly pid: number }
  | { readonly outcome: 'not_running' }
  | { readonly outcome: 'still_running'; readonly pid: number }
  // The lock of a process that is no daemon of the home, which kept every daemon out
  | { readonly outcome: 'cleared'; readonly pid: number }
  // A daemon of the home holds the lock but does not answer: stopped or busy, it is neither signalled nor cleared
  | { readonly outcome: 'silent'; readonly pid: number }

const ended = async (pid: number, deadline: number): Promise<boolean> => {
  const alive = isAlive(pid)
  if (!alive || Date.now() >= deadline) {
    return !alive
  }
  await sleep(100)
  return ended(pid, deadline)
}

// A daemon that ended since it answered has nothing left to stop
const terminate = (pid: number): void => {
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error
    }
  }
}

// A record whose pid is gone, or a file that is no record: one a daemon has written since it was read stays
const isStale = (record: ServerRecord): boolean => record.state === 'stale'

// The record of the daemon that ended, unless a daemon started since has written its own
const forget = (home: string, pid: number): void => {
  removeServerInfoIf(
    home,
    (record) => record.state === 'stale' && (record.info === undefined || record.info.pid === pid),
  )
}

// SIGTERM, then the wait for the pid to end; the record goes once it has
const terminated = async (home: string, pid: number, timeoutMs: number): Promise<StopOutcome> => {
  terminate(pid)
  if (!(await ended(pid, Date.now() + timeoutMs))) {
    return { outcome: 'still_running', pid }
  }
  forget(home, pid)
  return { outcome: 'stopped', pid }
}

// The daemon that holds the lock, once it answers as its record says; one still on its way up is waited for within the limit
const answering = async (home: string, pid: number, deadline: number): Promise<boolean> => {
  const running = await runningDaemon(home)
  if (running !== undefined && running.pid === pid) {
    return true
  }
  if (Date.now() >= deadline) {
    return false
  }
  await sleep(100)
  return answering(home, pid, deadline)
}

interface Stopping {
  readonly timeoutMs: number
  readonly judging: Judging
}

// No daemon answers as its record says: the lock tells whether one is on its way up, or whether a process that is no daemon of the home keeps every daemon out
const byTheLock = async (home: string, { timeoutMs, judging }: Stopping): Promise<StopOutcome> => {
  const lock = await clearStaleLock(home, judging)
  if (lock.kind === 'none') {
    return { outcome: 'not_running' }
  }
  if (lock.kind === 'cleared') {
    return { outcome: 'cleared', pid: lock.pid }
  }
  if (lock.kind === 'silent' || !(await answering(home, lock.pid, Date.now() + timeoutMs))) {
    return { outcome: 'silent', pid: lock.pid }
  }
  return terminated(home, lock.pid, timeoutMs)
}

/**
 * SIGTERM lets the daemon end its sessions and remove its record; it goes only to a daemon that answers as its record says.
 * A record is removed only once its pid is gone: a live pid that does not answer is never signalled.
 * Without a daemon that answers, the lock decides: a daemon still on its way up is stopped once it answers, one that does
 * not answer keeps its lock, and the lock of a process that is no daemon of the home (a pid taken over after a crash or a
 * reboot) is cleared.
 */
export const stopDaemon = async (
  home: string,
  timeoutMs = 5000,
  judging: Judging = JUDGING,
): Promise<StopOutcome> => {
  const record = readServerInfo(home)
  if (record.state === 'alive' && (await daemonAnswers(record.info))) {
    return terminated(home, record.info.pid, timeoutMs)
  }
  removeServerInfoIf(home, isStale)
  return byTheLock(home, { timeoutMs, judging })
}
