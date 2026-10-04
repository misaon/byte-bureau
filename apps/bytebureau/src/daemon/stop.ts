import { setTimeout as sleep } from 'node:timers/promises'
import { isAlive, readServerInfo, removeServerInfo } from './server-info.js'
import { runningDaemon } from './wait.js'

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

// SIGTERM lets the daemon end its sessions and remove its record; it goes only to a daemon that answers as its record says
// A process that took over the pid of a stale record is never signalled: the record is removed instead
export const stopDaemon = async (home: string, timeoutMs = 5000): Promise<StopOutcome> => {
  const daemon = await runningDaemon(home)
  if (daemon === undefined) {
    removeServerInfo(home)
    return { outcome: 'not_running' }
  }
  terminate(daemon.pid)
  if (!(await ended(daemon.pid, Date.now() + timeoutMs))) {
    return { outcome: 'still_running', pid: daemon.pid }
  }
  forget(home, daemon.pid)
  return { outcome: 'stopped', pid: daemon.pid }
}
