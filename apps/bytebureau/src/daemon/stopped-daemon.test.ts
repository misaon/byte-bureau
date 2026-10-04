import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { startDaemonProcess, type DaemonProcess } from '../testing/daemon.js'
import { testHome } from '../testing/temp-repo.js'
import { acquireLock } from './lock.js'
import { lockPath } from './server-info.js'
import type { DaemonChild } from './spawn.js'
import { awaitStart } from './start.js'
import { stopDaemon } from './stop.js'

// A judgement past the start of the daemon: no lock is young enough for a daemon on its way up, so its start decides
const PAST_START = { graceMs: 500, bootMs: 0 }

// The process of a start that has ended, as its starter sees it
const ENDED: DaemonChild = { ended: () => true }

// A daemon of a home of its own, stopped with SIGSTOP as Ctrl-Z or a debugger stops it
async function stoppedDaemon(): Promise<{ readonly home: string; readonly daemon: DaemonProcess }> {
  const home = testHome()
  const daemon = await startDaemonProcess(home)
  daemon.child.kill('SIGSTOP')
  return { home, daemon }
}

// The daemon goes on once it may, and ends as a daemon ends
async function resumedAndStopped(daemon: DaemonProcess): Promise<number | null> {
  daemon.child.kill('SIGCONT')
  const code = await daemon.stop()
  return code
}

describe.skipIf(process.platform === 'win32')('the lock of a daemon that is stopped', () => {
  it('stays with the daemon through a start, which names it as a daemon that does not answer', async () => {
    expect.hasAssertions()
    const { home, daemon } = await stoppedDaemon()
    const { pid } = daemon.info
    const taking = await acquireLock(home, PAST_START)
    const started = await awaitStart({ home, child: ENDED, judging: PAST_START })
    expect([taking, started]).toStrictEqual([
      { acquired: false, pid, holder: 'silent' },
      {
        up: false,
        reason: `A daemon of this home (pid ${pid}) holds the lock ${lockPath(home)} but does not answer; it may be stopped or busy`,
      },
    ])
    expect(readFileSync(lockPath(home), 'utf8')).toBe(String(pid))
    await expect(resumedAndStopped(daemon)).resolves.toBe(0)
  })

  it('stays with the daemon through a stop, which signals nothing and says it does not answer', async () => {
    expect.hasAssertions()
    const { home, daemon } = await stoppedDaemon()
    const { pid } = daemon.info
    await expect(stopDaemon(home, 500, PAST_START)).resolves.toStrictEqual({
      outcome: 'silent',
      pid,
    })
    expect(readFileSync(lockPath(home), 'utf8')).toBe(String(pid))
    await expect(resumedAndStopped(daemon)).resolves.toBe(0)
  })
})
