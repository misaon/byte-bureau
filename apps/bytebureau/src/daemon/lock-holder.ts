import { setTimeout as sleep } from 'node:timers/promises'
import type { FileStamp } from './files.js'
import { pidState, readServerInfo } from './server-info.js'
import { daemonAnswers } from './wait.js'

// What the lock of a home says, read at one moment
export interface HeldLock {
  // Nothing when the lock names no pid
  readonly pid: number | undefined
  readonly stamp: FileStamp
}

/**
 * Who holds the lock of a home:
 * - gone: the lock names no pid, or a pid that has ended;
 * - daemon: a daemon of the home, whose record names it and whose health answers, or one still on its way up;
 * - stranger: a live process of this user that is no daemon of the home, such as one that got the pid after a crash or a reboot;
 * - stuck: a live process of another user, which this user cannot look into, and no daemon of the home answers for it.
 */
export type Holder = 'gone' | 'daemon' | 'stranger' | 'stuck'

export interface Judging {
  // How long a record of the holder that answers may take to appear
  readonly graceMs: number
  // How young a lock is that a daemon still coming up holds: it writes its record once it has bound its port
  readonly bootMs: number
}

export const JUDGING: Judging = { graceMs: 2000, bootMs: 30_000 }

const answersFor = async (home: string, pid: number): Promise<boolean> => {
  const record = readServerInfo(home)
  if (record.state !== 'alive' || record.info.pid !== pid) {
    return false
  }
  const answers = await daemonAnswers(record.info)
  return answers
}

// A holder that ends meanwhile, such as a daemon on its way out, is no daemon to wait for
const answersWithin = async (home: string, pid: number, deadline: number): Promise<boolean> => {
  if (await answersFor(home, pid)) {
    return true
  }
  if (Date.now() >= deadline || pidState(pid) === 'dead') {
    return false
  }
  await sleep(100)
  return answersWithin(home, pid, deadline)
}

// A daemon still on its way up: a live process of this user whose lock is younger than a start may take
const isBooting = (held: HeldLock, judging: Judging = JUDGING): boolean =>
  held.pid !== undefined &&
  pidState(held.pid) === 'alive' &&
  Date.now() - held.stamp.mtimeMs < judging.bootMs

// Liveness of the pid alone would take any process that got the pid after a crash or a reboot for the daemon
export const judgeHolder = async (
  home: string,
  held: HeldLock,
  judging: Judging = JUDGING,
): Promise<Holder> => {
  const { pid } = held
  if (pid === undefined || pidState(pid) === 'dead') {
    return 'gone'
  }
  if (isBooting(held, judging) || (await answersWithin(home, pid, Date.now() + judging.graceMs))) {
    return 'daemon'
  }
  const state = pidState(pid)
  if (state === 'dead') {
    return 'gone'
  }
  return state === 'foreign' ? 'stuck' : 'stranger'
}
