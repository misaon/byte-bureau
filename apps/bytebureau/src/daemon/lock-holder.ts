import { setTimeout as sleep } from 'node:timers/promises'
import type { FileStamp } from './files.js'
import { processStartedAt } from './process-start.js'
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
 * - silent: the process that wrote the lock, which started before it was written, and does not answer: a daemon of
 *   the home that is stopped or busy, never a stranger;
 * - stranger: a process that started after the lock was written, which only got the pid of its writer after a crash or
 *   a reboot; where the platform cannot tell when a process started, a live process of this user that does not answer;
 * - stuck: where the platform cannot tell when a process started, a live process of another user, which this user
 *   cannot look into, and no daemon of the home answers for it.
 */
export type Holder = 'gone' | 'daemon' | 'silent' | 'stranger' | 'stuck'

// When a process started, or nothing when the platform cannot tell
type StartOf = (pid: number) => Promise<number | undefined>

export interface Judging {
  // How long a record of the holder that answers may take to appear
  readonly graceMs: number
  // How young a lock is that a daemon still coming up holds: it writes its record once it has bound its port
  readonly bootMs: number
  // The platform's own unless a test says otherwise
  readonly startOf?: StartOf | undefined
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

// A holder that does not answer: the writer of the lock, by its start, is a daemon that is stopped or busy
// Without its start, a live process of this user is taken for a stranger, and one of another user cannot be judged
const unanswered = (pid: number, started: number | undefined): Holder => {
  const state = pidState(pid)
  if (state === 'dead') {
    return 'gone'
  }
  if (started !== undefined) {
    return 'silent'
  }
  return state === 'foreign' ? 'stuck' : 'stranger'
}

// Liveness of the pid alone would take any process that got the pid after a crash or a reboot for the daemon
// An answer alone would take a daemon that is stopped or busy for a stranger: the start of the holder tells them apart
export const judgeHolder = async (
  home: string,
  held: HeldLock,
  judging: Judging = JUDGING,
): Promise<Holder> => {
  const { pid } = held
  if (pid === undefined || pidState(pid) === 'dead') {
    return 'gone'
  }
  const started = await (judging.startOf ?? processStartedAt)(pid)
  if (started !== undefined && started > held.stamp.mtimeMs) {
    return 'stranger'
  }
  if (isBooting(held, judging) || (await answersWithin(home, pid, Date.now() + judging.graceMs))) {
    return 'daemon'
  }
  return unanswered(pid, started)
}
