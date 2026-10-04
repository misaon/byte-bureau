import { spawn } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { healthStub, recordOn } from '../testing/health-stub.js'
import { tempDir } from '../testing/temp-repo.js'
import type { HeldLock } from './lock-holder.js'
import { acquireLock, heldLock, releaseLock, takeOverLock } from './lock.js'
import { lockPath, writeServerInfo } from './server-info.js'

// No process has this pid: the highest a system hands out is far below it
const DEAD_PID = 2_147_483_000

// A short grace, so that a holder that never answers is judged within the test
const QUICK = { graceMs: 200, bootMs: 30_000 }

// Pid 1 is another user's to everyone but root, who may signal it
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0

const LOCK_MODULE = fileURLToPath(new URL('lock.ts', import.meta.url))

const modeOf = (file: string): number => statSync(file).mode % 0o1000

// A lock left from before a crash or a reboot: written an hour ago
const oldLock = (home: string, pid: number | string): void => {
  writeFileSync(lockPath(home), String(pid))
  const anHourAgo = new Date(Date.now() - 3_600_000)
  utimesSync(lockPath(home), anHourAgo, anHourAgo)
}

interface Taker {
  readonly pid: number
  readonly outcome: unknown
}

// A process that reaches for the lock of the home at the moment given, prints what it got and stays alive, so a lock it took stays live
async function taker(home: string, at: number): Promise<Taker> {
  const script = [
    `import { acquireLock } from ${JSON.stringify(LOCK_MODULE)}`,
    `await Bun.sleep(Math.max(0, ${at} - 20 - Date.now()))`,
    `while (Date.now() < ${at}) {}`,
    `console.log(JSON.stringify(await acquireLock(${JSON.stringify(home)})))`,
    'setInterval(() => {}, 1000)',
  ].join('\n')
  const child = spawn('bun', ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  const { promise, resolve } = Promise.withResolvers<string>()
  child.stdout.setEncoding('utf8').once('data', (chunk: string) => {
    resolve(chunk)
  })
  const outcome: unknown = JSON.parse(await promise)
  return { pid: child.pid ?? 0, outcome }
}

const tookIt = ({ outcome }: Taker): boolean =>
  JSON.stringify(outcome) === JSON.stringify({ acquired: true })

// Two takers reach for the stale lock of a home at the same moment: one takes it, and the other names the one that did, a daemon on its way up
async function race(): Promise<{
  readonly got: readonly unknown[]
  readonly expected: readonly unknown[]
}> {
  const home = tempDir('bb-home-')
  writeFileSync(lockPath(home), String(DEAD_PID))
  const at = Date.now() + 1000
  const [first, second] = await Promise.all([taker(home, at), taker(home, at)])
  const expected = tookIt(first)
    ? [{ acquired: true }, { acquired: false, pid: first.pid, stuck: false }]
    : [{ acquired: false, pid: second.pid, stuck: false }, { acquired: true }]
  return { got: [first.outcome, second.outcome], expected }
}

describe('the daemon lock', () => {
  it('hands the lock to one holder, keeps it for a holder on its way up, and takes over a dead one', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    await expect(acquireLock(home)).resolves.toStrictEqual({ acquired: true })
    expect(modeOf(lockPath(home))).toBe(0o600)
    await expect(acquireLock(home)).resolves.toStrictEqual({
      acquired: false,
      pid: process.pid,
      stuck: false,
    })
    releaseLock(home)
    writeFileSync(lockPath(home), String(DEAD_PID))
    await expect(acquireLock(home)).resolves.toStrictEqual({ acquired: true })
    releaseLock(home)
    expect(existsSync(lockPath(home))).toBe(false)
  })

  it('takes over a lock that names no process, and leaves the lock of another holder alone', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), 'not a pid')
    await expect(acquireLock(home)).resolves.toStrictEqual({ acquired: true })
    // Pid 1 is alive on every system and is never this process
    writeFileSync(lockPath(home), '1')
    releaseLock(home)
    expect(readFileSync(lockPath(home), 'utf8')).toBe('1')
  })

  it('goes to exactly one of two takers that reach for a stale lock at the same moment', async () => {
    expect.hasAssertions()
    const rounds = await Promise.all([race(), race(), race()])
    expect(rounds.map(({ got }) => got)).toStrictEqual(rounds.map(({ expected }) => expected))
  })
})

describe('the daemon lock and a pid that lives on', () => {
  it('takes over the old lock of a live process of this user that is no daemon of the home', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    // This test's own pid stands for the process that got the pid of a daemon after a crash or a reboot
    oldLock(home, process.pid)
    await expect(acquireLock(home, QUICK)).resolves.toStrictEqual({ acquired: true })
    expect(Date.now() - statSync(lockPath(home)).mtimeMs).toBeLessThan(60_000)
    releaseLock(home)
  })

  it('keeps the old lock of a daemon of the home that answers as its record says', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    oldLock(home, process.pid)
    writeServerInfo(home, recordOn(await healthStub(), process.pid))
    await expect(acquireLock(home, QUICK)).resolves.toStrictEqual({
      acquired: false,
      pid: process.pid,
      stuck: false,
    })
  })
})

describe('the daemon lock and the record of its holder', () => {
  it('waits the grace for the record of a holder that is about to answer', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    oldLock(home, process.pid)
    const port = await healthStub()
    const acquired = acquireLock(home, { graceMs: 5000, bootMs: 30_000 })
    await sleep(300)
    writeServerInfo(home, recordOn(port, process.pid))
    await expect(acquired).resolves.toStrictEqual({
      acquired: false,
      pid: process.pid,
      stuck: false,
    })
  })

  it.skipIf(ROOT)(
    'refuses as stuck the old lock of a process of another user that no daemon of the home answers for',
    async () => {
      expect.hasAssertions()
      const home = tempDir('bb-home-')
      oldLock(home, 1)
      await expect(acquireLock(home, QUICK)).resolves.toStrictEqual({
        acquired: false,
        pid: 1,
        stuck: true,
      })
      expect(readFileSync(lockPath(home), 'utf8')).toBe('1')
    },
  )
})

// The lock judged is gone, as its holder or another taker removed it; a racing taker may have made its own since
const replaced = (home: string, by?: string): void => {
  rmSync(lockPath(home))
  if (by !== undefined) {
    writeFileSync(lockPath(home), by)
    // Another file, whichever inode the system hands out again
    const later = new Date(Date.now() + 60_000)
    utimesSync(lockPath(home), later, later)
  }
}

// The lock of the home as a taker judged it; each test writes one first
const judgedLock = (home: string): HeldLock => {
  const held = heldLock(home)
  if (held === undefined) {
    throw new Error(`no lock in ${home}`)
  }
  return held
}

describe(takeOverLock, () => {
  it('removes the lock that was judged, and leaves nothing aside', () => {
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), String(DEAD_PID))
    expect(takeOverLock(home, judgedLock(home))).toBe(true)
    expect(readdirSync(home)).toStrictEqual([])
  })

  it('leaves in place a lock that a holder made after the judgement', () => {
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), String(DEAD_PID))
    const judged = judgedLock(home)
    // The holder judged gone let go of the lock, and a racing taker made its own
    replaced(home, '1')
    expect(takeOverLock(home, judged)).toBe(false)
    expect(readdirSync(home)).toStrictEqual(['daemon.lock'])
    expect(readFileSync(lockPath(home), 'utf8')).toBe('1')
  })

  it('finds nothing to do when another taker moved the lock first', () => {
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), String(DEAD_PID))
    const judged = judgedLock(home)
    replaced(home)
    expect(takeOverLock(home, judged)).toBe(false)
    expect(readdirSync(home)).toStrictEqual([])
  })
})
