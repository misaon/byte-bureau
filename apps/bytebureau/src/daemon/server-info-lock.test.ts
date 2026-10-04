import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { tempDir } from '../testing/temp-repo.js'
import { acquireLock, lockPath, releaseLock, takeOverLock } from './server-info.js'

// No process has this pid: the highest a system hands out is far below it
const DEAD_PID = 2_147_483_000

const SERVER_INFO = fileURLToPath(new URL('server-info.ts', import.meta.url))

const modeOf = (file: string): number => statSync(file).mode % 0o1000

interface Taker {
  readonly pid: number
  readonly outcome: unknown
}

// A process that reaches for the lock of the home at the moment given, prints what it got and stays alive, so a lock it took stays live
async function taker(home: string, at: number): Promise<Taker> {
  const script = [
    `import { acquireLock } from ${JSON.stringify(SERVER_INFO)}`,
    `await Bun.sleep(Math.max(0, ${at} - 20 - Date.now()))`,
    `while (Date.now() < ${at}) {}`,
    `console.log(JSON.stringify(acquireLock(${JSON.stringify(home)})))`,
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

// Two takers reach for the stale lock of a home at the same moment: one takes it, and the other names the one that did
async function race(): Promise<{
  readonly got: readonly unknown[]
  readonly expected: readonly unknown[]
}> {
  const home = tempDir('bb-home-')
  writeFileSync(lockPath(home), String(DEAD_PID))
  const at = Date.now() + 1000
  const [first, second] = await Promise.all([taker(home, at), taker(home, at)])
  const expected = tookIt(first)
    ? [{ acquired: true }, { acquired: false, pid: first.pid }]
    : [{ acquired: false, pid: second.pid }, { acquired: true }]
  return { got: [first.outcome, second.outcome], expected }
}

describe('the daemon lock', () => {
  it('hands the lock to one holder, names a live holder to the next, and takes over a dead one', () => {
    const home = tempDir('bb-home-')
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
    expect(modeOf(lockPath(home))).toBe(0o600)
    expect(acquireLock(home)).toStrictEqual({ acquired: false, pid: process.pid })
    releaseLock(home)
    writeFileSync(lockPath(home), String(DEAD_PID))
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
    releaseLock(home)
    expect(existsSync(lockPath(home))).toBe(false)
  })

  it('takes over a lock that names no process, and leaves the lock of another holder alone', () => {
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), 'not a pid')
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
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

describe(takeOverLock, () => {
  it('removes the lock of a holder that is gone, and leaves nothing aside', () => {
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), String(DEAD_PID))
    expect(takeOverLock(home)).toBeUndefined()
    expect(readdirSync(home)).toStrictEqual([])
  })

  it('puts back a lock that a live process made since the stale one was read, and names that process', () => {
    const home = tempDir('bb-home-')
    // Pid 1 is alive on every system: its lock stands for one a racing taker has just made
    writeFileSync(lockPath(home), '1')
    expect(takeOverLock(home)).toStrictEqual({ acquired: false, pid: 1 })
    expect(readdirSync(home)).toStrictEqual(['daemon.lock'])
    expect(readFileSync(lockPath(home), 'utf8')).toBe('1')
  })

  it('lets a taker that read the stale holder before another took the lock over leave that lock in place', () => {
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), String(DEAD_PID))
    // Both takers have read the dead holder; the first takes the lock over, then the second moves what is there now
    expect(acquireLock(home)).toStrictEqual({ acquired: true })
    expect(takeOverLock(home)).toStrictEqual({ acquired: false, pid: process.pid })
    expect(readFileSync(lockPath(home), 'utf8')).toBe(String(process.pid))
    releaseLock(home)
  })

  it('finds nothing to do when another taker moved the lock first', () => {
    const home = tempDir('bb-home-')
    expect(takeOverLock(home)).toBeUndefined()
    expect(readdirSync(home)).toStrictEqual([])
  })
})
