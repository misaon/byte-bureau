import { setTimeout as sleep } from 'node:timers/promises'
import { isAlive, readServerInfo, removeServerInfo } from './server-info.js'
import { daemonAnswers } from './wait.js'

export type StopOutcome =
  | { readonly outcome: 'stopped'; readonly pid: number }
  | { readonly outcome: 'not_running' }
  | { readonly outcome: 'still_running'; readonly pid: number }

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

// The record of the daemon that ended, unless a daemon started since has written its own
const forget = (home: string, pid: number): void => {
  const record = readServerInfo(home)
  if (record.state === 'stale' && (record.info === undefined || record.info.pid === pid)) {
    removeServerInfo(home)
  }
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

// SIGTERM lets the daemon end its sessions and remove its record; it goes only to a daemon that answers as its record says
// A record is removed only once its pid is gone: a live pid that does not answer is neither signalled nor forgotten
// Such a pid is a daemon shutting down or stalled, or a process that took over the pid of a stale record
export const stopDaemon = async (home: string, timeoutMs = 5000): Promise<StopOutcome> => {
  const record = readServerInfo(home)
  if (record.state !== 'alive') {
    removeServerInfo(home)
    return { outcome: 'not_running' }
  }
  const { pid } = record.info
  if (!(await daemonAnswers(record.info))) {
    return { outcome: 'still_running', pid }
  }
  const outcome = await terminated(home, pid, timeoutMs)
  return outcome
}
