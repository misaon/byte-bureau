import { readdirSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { linkedWithPid, pidIn, removeIfSame, removeIfThere, stampOf } from './files.js'
import { lockPath, pidState } from './server-info.js'

const mutexPath = (home: string): string => `${lockPath(home)}.takeover`

// A judgement of the lock takes a few seconds at most: a mutex older than this was left by a taker that is gone
const STALE_MS = 15_000

// Longer than a stale mutex lives, so that a waiter outlasts one a crashed taker left
const WAIT_MS = 20_000

// The mutex of a taker that died, or that has held it far longer than any judgement takes, is in nobody's hands
const clearIfStale = (home: string): void => {
  const file = mutexPath(home)
  const stamp = stampOf(file)
  const holder = pidIn(file)
  if (stamp === undefined) {
    return
  }
  const dead = holder !== undefined && pidState(holder) === 'dead'
  if (dead || Date.now() - stamp.mtimeMs > STALE_MS) {
    removeIfSame(file, stamp)
  }
}

const taken = async (home: string, deadline: number): Promise<void> => {
  if (linkedWithPid(mutexPath(home))) {
    return
  }
  clearIfStale(home)
  if (Date.now() >= deadline) {
    throw new Error(`the lock ${lockPath(home)} keeps changing hands; try again`)
  }
  await sleep(25)
  await taken(home, deadline)
}

/**
 * The work of one taker of the lock at a time: judging the holder, taking a stale lock over, clearing it.
 * A short-lived file made exclusively, so that no taker moves the lock while another judges or puts it back.
 */
export async function withTakeoverMutex<Result>(
  home: string,
  work: () => Promise<Result>,
): Promise<Result> {
  await taken(home, Date.now() + WAIT_MS)
  try {
    const result = await work()
    return result
  } finally {
    if (pidIn(mutexPath(home)) === process.pid) {
      removeIfThere(mutexPath(home))
    }
  }
}

// What a taker or a writer leaves aside for a moment, named by its pid: a draft, a lock or a record moved aside, a temp file
const LEFTOVER =
  /^(?:daemon\.lock|daemon\.lock\.takeover|server\.json|daemon\.token)\.(?<pid>\d+)(?:\.stale|\.tmp)?$/u

// What a process that died left aside in the home; a live one's own files are its own business
export const clearLeftovers = (home: string): void => {
  for (const name of readdirSync(home)) {
    const found = LEFTOVER.exec(name)
    const pid = found === null || found.groups === undefined ? undefined : found.groups['pid']
    if (pid !== undefined && pidState(Number(pid)) === 'dead') {
      removeIfThere(path.join(home, name))
    }
  }
}
