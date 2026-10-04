import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, utimesSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it, onTestFinished } from 'vitest'
import { healthStub, recordOn } from '../testing/health-stub.js'
import { tempDir } from '../testing/temp-repo.js'
import { lockPath, readServerInfo, writeServerInfo } from './server-info.js'
import { stopDaemon } from './stop.js'

// No process has this pid: the highest a system hands out is far below it
const DEAD_PID = 2_147_483_000

// A short grace, so that a holder that never answers is judged within the test
const QUICK = { graceMs: 200, bootMs: 30_000 }

// A lock left from before a crash or a reboot: written an hour ago
const oldLock = (home: string, pid: number): void => {
  writeFileSync(lockPath(home), String(pid))
  const anHourAgo = new Date(Date.now() - 3_600_000)
  utimesSync(lockPath(home), anHourAgo, anHourAgo)
}

// A process that stands in for the daemon of a record, killed when the test ends; one that ignores SIGTERM outlives a stop
async function standIn(ignoresSigterm: boolean): Promise<number> {
  const handler = ignoresSigterm ? "process.on('SIGTERM', () => {});" : ''
  const script = `${handler} setInterval(() => {}, 1000); console.log('ready')`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  await once(child.stdout, 'data')
  return child.pid ?? 0
}

describe(stopDaemon, () => {
  it('finds no daemon in a home without one, and removes a record whose pid is gone', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    await expect(stopDaemon(home)).resolves.toStrictEqual({ outcome: 'not_running' })
    writeServerInfo(home, recordOn(1, 2_147_483_000))
    await expect(stopDaemon(home)).resolves.toStrictEqual({ outcome: 'not_running' })
    expect(readServerInfo(home)).toStrictEqual({ state: 'absent' })
  })

  it('neither signals nor forgets a live pid that does not answer as the daemon of the record', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    // The record names this very process, on a port where no daemon answers: a SIGTERM would end the test run
    // No lock names it, and a daemon of the home holds its lock from its start on
    writeServerInfo(home, recordOn(1, process.pid))
    await expect(stopDaemon(home, 300, QUICK)).resolves.toStrictEqual({ outcome: 'not_running' })
    expect(readServerInfo(home)).toStrictEqual({ state: 'alive', info: recordOn(1, process.pid) })
  })

  it('ends the daemon that answers and removes its record', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const pid = await standIn(false)
    writeServerInfo(home, recordOn(await healthStub(), pid))
    await expect(stopDaemon(home)).resolves.toStrictEqual({ outcome: 'stopped', pid })
    expect(readServerInfo(home)).toStrictEqual({ state: 'absent' })
  })

  it('tells of a daemon that outlives the limit and keeps its record', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const pid = await standIn(true)
    writeServerInfo(home, recordOn(await healthStub(), pid))
    await expect(stopDaemon(home, 300)).resolves.toStrictEqual({ outcome: 'still_running', pid })
    expect(readServerInfo(home).state).toBe('alive')
  })
})

describe('stopDaemon and the lock of the home', () => {
  it('clears the old lock of a live process that is no daemon of the home, and names it', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    // This test's own pid stands for the process that got the pid of a daemon after a crash or a reboot: it is never signalled
    oldLock(home, process.pid)
    await expect(stopDaemon(home, 300, QUICK)).resolves.toStrictEqual({
      outcome: 'cleared',
      pid: process.pid,
    })
    expect(existsSync(lockPath(home))).toBe(false)
  })

  it('removes the lock of a holder that is gone without a word', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    oldLock(home, DEAD_PID)
    await expect(stopDaemon(home, 300, QUICK)).resolves.toStrictEqual({ outcome: 'not_running' })
    expect(existsSync(lockPath(home))).toBe(false)
  })

  it('stops a daemon on its way up once it answers', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const pid = await standIn(false)
    // A fresh lock, and the record the daemon writes once it has bound its port
    writeFileSync(lockPath(home), String(pid))
    const port = await healthStub()
    const stopped = stopDaemon(home, 3000, QUICK)
    await sleep(300)
    writeServerInfo(home, recordOn(port, pid))
    await expect(stopped).resolves.toStrictEqual({ outcome: 'stopped', pid })
  })
})
