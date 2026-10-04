import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { healthStub, recordOn } from '../testing/health-stub.js'
import { unknownStart } from '../testing/old-lock.js'
import { tempDir } from '../testing/temp-repo.js'
import { lockPath, writeServerInfo } from './server-info.js'
import { daemonLogPath } from './daemon-log.js'
import type { DaemonChild } from './spawn.js'
import { awaitStart } from './start.js'

// The process of a start, as its starter sees it: still running, or ended
const RUNNING: DaemonChild = { ended: () => false }
const ENDED: DaemonChild = { ended: () => true }

// A short grace, so that a holder that never answers is judged within the test
const QUICK = { graceMs: 200, bootMs: 30_000 }

// Pid 1 is another user's to everyone but root, who may signal it
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0

describe(awaitStart, () => {
  it('is up once the daemon of the home has written its record and answers', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const port = await healthStub()
    const started = awaitStart({ home, child: RUNNING, judging: QUICK })
    await sleep(200)
    writeServerInfo(home, recordOn(port))
    await expect(started).resolves.toStrictEqual({ up: true, info: recordOn(port) })
  })

  it('fails at once, naming the log, when the process of the start has ended and holds no lock', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const since = Date.now()
    await expect(awaitStart({ home, child: ENDED, judging: QUICK })).resolves.toStrictEqual({
      up: false,
      reason: `The daemon failed to start; see ${daemonLogPath(home)}`,
    })
    expect(Date.now() - since).toBeLessThan(5000)
  })

  it('waits for the daemon on its way up that holds the lock, which a racing start made', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    // A fresh lock of a live process: this test's own pid stands for the other start's daemon
    writeFileSync(lockPath(home), String(process.pid))
    const port = await healthStub()
    const started = awaitStart({ home, child: ENDED, judging: QUICK })
    await sleep(300)
    writeServerInfo(home, recordOn(port))
    await expect(started).resolves.toStrictEqual({ up: true, info: recordOn(port) })
  })
})

describe('awaitStart when the process of the start has ended', () => {
  it.skipIf(ROOT)(
    'names the lock, its pid and the way out when a process of another user holds it, whose start cannot be told',
    async () => {
      expect.hasAssertions()
      const home = tempDir('bb-home-')
      writeFileSync(lockPath(home), '1')
      const judging = { ...QUICK, startOf: unknownStart }
      const started = await awaitStart({ home, child: ENDED, judging })
      expect(started).toStrictEqual({
        up: false,
        reason: `The lock ${lockPath(home)} names pid 1, which does not answer as a daemon of this home; if none is running, clear the lock with bytebureau serve --stop`,
      })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'names the lock and its pid when the daemon that wrote it holds it without answering',
    async () => {
      expect.hasAssertions()
      const home = tempDir('bb-home-')
      // Written by this test's own process, which started before it: a daemon stopped or busy, past its start
      writeFileSync(lockPath(home), String(process.pid))
      const judging = { graceMs: 200, bootMs: 0 }
      await expect(awaitStart({ home, child: ENDED, judging })).resolves.toStrictEqual({
        up: false,
        reason: `A daemon of this home (pid ${process.pid}) holds the lock ${lockPath(home)} but does not answer; it may be stopped or busy`,
      })
    },
  )

  it('gives up on a start that does not come up within the limit, naming the log', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    await expect(
      awaitStart({ home, child: RUNNING, limitMs: 300, judging: QUICK }),
    ).resolves.toStrictEqual({
      up: false,
      reason: `The daemon did not come up in time; see ${daemonLogPath(home)}`,
    })
  })
})
