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
 * - silent: a holder that does not answer and started before the lock was written, or within a tolerance after it: the
 *   daemon that wrote it, stopped or busy, never a stranger;
 * - stranger: a holder that does not answer and started well after the lock was written, which only got the pid of its
 *   writer after a crash or a reboot; where the platform cannot tell when a process started, a live process of this
 *   user that does not answer;
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
// No allowance means none: a lock written this very millisecond reads a little younger than nothing, its time being finer
// A lock that reads from the future, as after a clock stepped back, stays within an allowance there is
const isBooting = (held: HeldLock, judging: Judging = JUDGING): boolean =>
  judging.bootMs > 0 &&
  held.pid !== undefined &&
  pidState(held.pid) === 'alive' &&
  Date.now() - held.stamp.mtimeMs < judging.bootMs

// How much later than the lock its writer may seem to have started: a clock stepped since disagrees by a few seconds
// So do the file times of a network share or a FAT disk; a holder that started later than that only got the pid
const START_TOLERANCE_MS = 5000

// A holder that does not answer and is not on its way up, judged by its start: the writer of the lock keeps it
// That writer is stopped or busy; a holder that started well after the lock was written loses it
// Without its start, a live process of this user is taken for a stranger, and one of another user cannot be judged
const unanswered = (pid: number, started: number | undefined, written: number): Holder => {
  const state = pidState(pid)
  if (state === 'dead') {
    return 'gone'
  }
  if (started === undefined) {
    return state === 'foreign' ? 'stuck' : 'stranger'
  }
  return started > written + START_TOLERANCE_MS ? 'stranger' : 'silent'
}

// A holder that answers as its record says, or may still be coming up, is the daemon whatever its start says
// Only then does its start decide: liveness of the pid alone would keep the lock for a process that got the pid later
// An answer alone would take a daemon that is stopped or busy for a stranger
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
  const started = await (judging.startOf ?? processStartedAt)(pid)
  return unanswered(pid, started, held.stamp.mtimeMs)
}
