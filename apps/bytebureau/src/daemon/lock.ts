import { mkdirSync } from 'node:fs'
import { linkedWithPid, pidIn, removeIfSame, removeIfThere, stampOf } from './files.js'
import { JUDGING, judgeHolder, type HeldLock, type Judging } from './lock-holder.js'
import { clearLeftovers, withTakeoverMutex } from './lock-mutex.js'
import { lockHolder, lockPath } from './server-info.js'

export type LockOutcome =
  | { readonly acquired: true }
  // Stuck: the holder is no daemon of the home that answers, but it is not this user's process to take the lock from
  | { readonly acquired: false; readonly pid: number; readonly stuck: boolean }

// The lock of the home as it is now, or nothing when there is none
export const heldLock = (home: string): HeldLock | undefined => {
  const stamp = stampOf(lockPath(home))
  return stamp === undefined ? undefined : { pid: pidIn(lockPath(home)), stamp }
}

/**
 * Moves the lock that was judged stale out of the way: the existing rename path, which only one taker can win.
 * Only the lock that was judged goes; a lock made since stays, and the caller judges it in its next round.
 */
export const takeOverLock = (home: string, judged: HeldLock): boolean =>
  removeIfSame(lockPath(home), judged.stamp)

// Rounds before a lock that keeps changing hands is given up on; a lock that its holder lets go of meanwhile takes one more
const ROUNDS = 5

// What the holder of the lock is: one that keeps it is named, one that is gone or is no daemon of the home loses it
const judged = async (home: string, judging: Judging): Promise<LockOutcome | undefined> => {
  const held = heldLock(home)
  if (held === undefined) {
    return undefined
  }
  const holder = await judgeHolder(home, held, judging)
  if (held.pid !== undefined && (holder === 'daemon' || holder === 'stuck')) {
    return { acquired: false, pid: held.pid, stuck: holder === 'stuck' }
  }
  takeOverLock(home, held)
  return undefined
}

// Each round takes the lock, names a holder that keeps it, or moves the lock of a holder that is gone or no daemon of the home and goes again
const lockOf = async (home: string, judging: Judging, rounds: number): Promise<LockOutcome> => {
  if (linkedWithPid(lockPath(home))) {
    return { acquired: true }
  }
  const refused = await judged(home, judging)
  if (refused !== undefined) {
    return refused
  }
  if (rounds <= 1) {
    throw new Error(`the lock ${lockPath(home)} keeps changing hands; try again`)
  }
  return lockOf(home, judging, rounds - 1)
}

// One daemon per home, decided under the takeover mutex: a daemon of the home keeps the lock, and the lock of a holder that is gone or is no daemon of the home is taken over
export const acquireLock = async (
  home: string,
  judging: Judging = JUDGING,
): Promise<LockOutcome> => {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const outcome = await withTakeoverMutex(home, async () => {
    clearLeftovers(home)
    const taken = await lockOf(home, judging, ROUNDS)
    return taken
  })
  return outcome
}

// Only the lock of this process is released: a lock another daemon has taken over is that daemon's
export const releaseLock = (home: string): void => {
  if (lockHolder(home) === process.pid) {
    removeIfThere(lockPath(home))
  }
}

export type Cleared =
  | { readonly kind: 'none' }
  | { readonly kind: 'cleared'; readonly pid: number }
  // A daemon of the home holds the lock: it answers, or it is still on its way up
  | { readonly kind: 'held'; readonly pid: number }

// The lock of a holder that is no daemon of the home, cleared on request: a process that got the pid after a crash or a reboot, of this user or another
// The lock of a holder that is gone goes without a word
export const clearStaleLock = async (
  home: string,
  judging: Judging = JUDGING,
): Promise<Cleared> => {
  const cleared = await withTakeoverMutex(home, async (): Promise<Cleared> => {
    const held = heldLock(home)
    if (held === undefined) {
      return { kind: 'none' }
    }
    const holder = await judgeHolder(home, held, judging)
    if (holder === 'daemon' && held.pid !== undefined) {
      return { kind: 'held', pid: held.pid }
    }
    const removed = takeOverLock(home, held)
    return removed && holder !== 'gone' && held.pid !== undefined
      ? { kind: 'cleared', pid: held.pid }
      : { kind: 'none' }
  })
  return cleared
}
