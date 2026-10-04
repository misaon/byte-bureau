import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { healthStub, recordOn } from '../testing/health-stub.js'
import { lockReadBefore, oldLock, unknownStart } from '../testing/old-lock.js'
import { tempDir } from '../testing/temp-repo.js'
import { acquireLock, releaseLock } from './lock.js'
import { lockPath, writeServerInfo } from './server-info.js'

// A short grace, so that a holder that never answers is judged within the test
const QUICK = { graceMs: 200, bootMs: 30_000 }

// The same, for a holder past its start: no lock is young enough to be a daemon on its way up
const PAST_START = { graceMs: 200, bootMs: 0 }

// Pid 1 is another user's to everyone but root, who may signal it
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0

// Ps tells the start of a process on macOS and Linux
const POSIX = process.platform !== 'win32'

describe('the daemon lock and a pid that lives on', () => {
  it('takes over a lock written before its live holder of this user started', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    // This test's own pid stands for the process that got the pid of a daemon after a crash or a reboot
    await oldLock(home, process.pid)
    await expect(acquireLock(home, QUICK)).resolves.toStrictEqual({ acquired: true })
    expect(Date.now() - statSync(lockPath(home)).mtimeMs).toBeLessThan(60_000)
    releaseLock(home)
  })

  it.skipIf(!POSIX)(
    'takes over a lock written before its holder started, though the process is of another user',
    async () => {
      expect.hasAssertions()
      const home = tempDir('bb-home-')
      await oldLock(home, 1)
      await expect(acquireLock(home, QUICK)).resolves.toStrictEqual({ acquired: true })
      releaseLock(home)
    },
  )

  it('keeps the lock of a daemon of the home that answers as its record says, past its start', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), String(process.pid))
    writeServerInfo(home, recordOn(await healthStub(), process.pid))
    await expect(acquireLock(home, PAST_START)).resolves.toStrictEqual({
      acquired: false,
      pid: process.pid,
      holder: 'daemon',
    })
  })

  it.skipIf(!POSIX)(
    'keeps the lock of the process that wrote it, which does not answer: a daemon stopped or busy',
    async () => {
      expect.hasAssertions()
      const home = tempDir('bb-home-')
      // Written by this test's own process, which started before it and stands for the daemon
      writeFileSync(lockPath(home), String(process.pid))
      await expect(acquireLock(home, PAST_START)).resolves.toStrictEqual({
        acquired: false,
        pid: process.pid,
        holder: 'silent',
      })
      expect(readFileSync(lockPath(home), 'utf8')).toBe(String(process.pid))
    },
  )
})

describe('the daemon lock and a clock or a file system that disagree a little', () => {
  it.skipIf(!POSIX)(
    'keeps the lock of a holder that seems to have started up to five seconds after it was written',
    async () => {
      expect.hasAssertions()
      const home = tempDir('bb-home-')
      writeFileSync(lockPath(home), String(process.pid))
      await lockReadBefore(home, process.pid, 3000)
      await expect(acquireLock(home, PAST_START)).resolves.toStrictEqual({
        acquired: false,
        pid: process.pid,
        holder: 'silent',
      })
    },
  )

  it.skipIf(!POSIX)(
    'takes over the lock of a holder that started well after it was written',
    async () => {
      expect.hasAssertions()
      const home = tempDir('bb-home-')
      writeFileSync(lockPath(home), String(process.pid))
      await lockReadBefore(home, process.pid, 10_000)
      await expect(acquireLock(home, PAST_START)).resolves.toStrictEqual({ acquired: true })
      releaseLock(home)
    },
  )
})

describe('the daemon lock and the record of its holder', () => {
  it('waits the grace for the record of a holder that is about to answer', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), String(process.pid))
    const port = await healthStub()
    const acquired = acquireLock(home, { graceMs: 5000, bootMs: 0 })
    await sleep(300)
    writeServerInfo(home, recordOn(port, process.pid))
    await expect(acquired).resolves.toStrictEqual({
      acquired: false,
      pid: process.pid,
      holder: 'daemon',
    })
  })
})

describe('the daemon lock where the platform cannot tell when a process started', () => {
  it('takes over the old lock of a live process of this user that does not answer', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    writeFileSync(lockPath(home), String(process.pid))
    const anHourAgo = new Date(Date.now() - 3_600_000)
    utimesSync(lockPath(home), anHourAgo, anHourAgo)
    await expect(acquireLock(home, { ...QUICK, startOf: unknownStart })).resolves.toStrictEqual({
      acquired: true,
    })
    releaseLock(home)
  })

  it.skipIf(ROOT)(
    'refuses as stuck the lock of a process of another user that no daemon of the home answers for',
    async () => {
      expect.hasAssertions()
      const home = tempDir('bb-home-')
      writeFileSync(lockPath(home), '1')
      const judging = { ...QUICK, startOf: unknownStart }
      await expect(acquireLock(home, judging)).resolves.toStrictEqual({
        acquired: false,
        pid: 1,
        holder: 'stuck',
      })
      expect(readFileSync(lockPath(home), 'utf8')).toBe('1')
    },
  )
})
