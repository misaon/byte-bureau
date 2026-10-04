import { appendFileSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isAlive, lockHolder, readServerInfo } from '../daemon/server-info.js'

// The directory of the run's list of scratch homes, which the global setup of the project makes
export const RUN_DIRECTORY = 'BB_TEST_RUN_DIR'

const listOf = (run: string): string => path.join(run, 'homes')

// A scratch directory of a test, written down so the sweep at the end of the run can look into it
export function registerScratch(directory: string): void {
  const run = process.env[RUN_DIRECTORY]
  if (run !== undefined) {
    appendFileSync(listOf(run), `${directory}\n`)
  }
}

// The scratch directories the tests of the run wrote down
export function scratchOf(run: string): readonly string[] {
  try {
    return readFileSync(listOf(run), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
  } catch {
    return []
  }
}

// Processes no sweep signals: the init process, and the one that sweeps
const UNTOUCHABLE: ReadonlySet<number> = new Set([1, process.pid, process.ppid])

// The live processes the lock and the record of a home name: a daemon that outlived its test
const daemonsIn = (home: string): readonly number[] => {
  const record = readServerInfo(home)
  const recorded = record.state === 'alive' ? [record.info.pid] : []
  const holder = lockHolder(home)
  const named = new Set([...recorded, ...(holder === undefined ? [] : [holder])])
  return [...named].filter((pid) => !UNTOUCHABLE.has(pid) && isAlive(pid))
}

const signal = (pid: number, name: NodeJS.Signals): void => {
  try {
    process.kill(pid, name)
  } catch {
    // Gone already
  }
}

const ended = async (pids: readonly number[], deadline: number): Promise<boolean> => {
  if (pids.every((pid) => !isAlive(pid)) || Date.now() >= deadline) {
    return pids.every((pid) => !isAlive(pid))
  }
  await sleep(100)
  return ended(pids, deadline)
}

/**
 * Ends what a test left running in its scratch homes and removes them: a test that timed out may have gone on and
 * started a daemon after its cleanup ran. SIGTERM first, SIGKILL for one that outlives the wait. Gives the pids it ended.
 */
export async function sweepHomes(directories: readonly string[]): Promise<readonly number[]> {
  const daemons = directories.flatMap((directory) => daemonsIn(directory))
  for (const pid of daemons) {
    signal(pid, 'SIGTERM')
  }
  if (!(await ended(daemons, Date.now() + 3000))) {
    for (const pid of daemons) {
      signal(pid, 'SIGKILL')
    }
  }
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true })
  }
  return daemons
}
