import { existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { clearLeftovers, withTakeoverMutex } from './lock-mutex.js'
import { lockPath } from './server-info.js'

// No process has this pid: the highest a system hands out is far below it
const DEAD_PID = 2_147_483_000

const mutexOf = (home: string): string => `${lockPath(home)}.takeover`

const work = async (): Promise<string> => {
  await Promise.resolve()
  return 'judged'
}

// The work under the mutex, which marks when it has run
async function marked(home: string, settled: { done: boolean }): Promise<string> {
  const result = await withTakeoverMutex(home, work)
  settled.done = true
  return result
}

describe(withTakeoverMutex, () => {
  it('holds the mutex for the length of the work and lets go of it after', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const seen = await withTakeoverMutex(home, async () => {
      await Promise.resolve()
      return existsSync(mutexOf(home))
    })
    expect([seen, existsSync(mutexOf(home))]).toStrictEqual([true, false])
  })

  it('takes over the mutex of a taker that died', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    writeFileSync(mutexOf(home), String(DEAD_PID))
    await expect(withTakeoverMutex(home, work)).resolves.toBe('judged')
    expect(existsSync(mutexOf(home))).toBe(false)
  })

  it('waits for a live taker to let go of the mutex', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    // Pid 1 is alive on every system and is never this process
    writeFileSync(mutexOf(home), '1')
    const settled = { done: false }
    const judged = marked(home, settled)
    await sleep(300)
    expect(settled.done).toBe(false)
    rmSync(mutexOf(home))
    await expect(judged).resolves.toBe('judged')
  })

  it('clears a mutex older than any judgement takes, whoever it names', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    writeFileSync(mutexOf(home), '1')
    const aMinuteAgo = new Date(Date.now() - 60_000)
    utimesSync(mutexOf(home), aMinuteAgo, aMinuteAgo)
    await expect(withTakeoverMutex(home, work)).resolves.toBe('judged')
  })
})

describe(clearLeftovers, () => {
  it('removes what takers and writers that died left aside, and nothing of a live process', () => {
    const home = tempDir('bb-home-')
    const leftovers = [
      `daemon.lock.${DEAD_PID}`,
      `daemon.lock.${DEAD_PID}.stale`,
      `daemon.lock.takeover.${DEAD_PID}`,
      `daemon.lock.takeover.${DEAD_PID}.stale`,
      `server.json.${DEAD_PID}.stale`,
      `server.json.${DEAD_PID}.tmp`,
      `daemon.token.${DEAD_PID}.tmp`,
    ]
    const kept = ['daemon.lock', 'server.json', `server.json.${process.pid}.tmp`, 'notes.1234']
    for (const name of [...leftovers, ...kept]) {
      writeFileSync(path.join(home, name), '')
    }
    clearLeftovers(home)
    expect(readdirSync(home).toSorted()).toStrictEqual(kept.toSorted())
  })
})
