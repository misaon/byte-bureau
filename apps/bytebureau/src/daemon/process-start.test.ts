import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it, onTestFinished } from 'vitest'
import { lstartTime, processStartedAt } from './process-start.js'

// No process has this pid: the highest a system hands out is far below it
const DEAD_PID = 2_147_483_000

// The start of a second, which is as far as ps tells a start
const toSecond = (time: number): number => Math.floor(time / 1000) * 1000

const pidOf = (child: ChildProcess): number => child.pid ?? 0

describe(lstartTime, () => {
  it('reads the start ps prints in the C locale and UTC, a day of one digit too', () => {
    expect(lstartTime('Wed Sep 30 08:15:00 2026    \n')).toBe(Date.UTC(2026, 8, 30, 8, 15, 0))
    expect(lstartTime('Sun Oct  4 17:30:45 2026')).toBe(Date.UTC(2026, 9, 4, 17, 30, 45))
  })

  it('reads nothing from the words of another locale, or from no start at all', () => {
    expect([
      lstartTime('st 30 zář 10:15:00 2026'),
      lstartTime(''),
      lstartTime('Wed Foo 30 08:15:00 2026'),
    ]).toStrictEqual([undefined, undefined, undefined])
  })
})

describe.skipIf(process.platform === 'win32')(processStartedAt, () => {
  it('tells the start of a process, to the second it started in', async () => {
    expect.hasAssertions()
    const before = toSecond(Date.now())
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    onTestFinished(() => {
      child.kill('SIGKILL')
    })
    await once(child, 'spawn')
    const after = Date.now()
    const started = await processStartedAt(pidOf(child))
    expect(started).toBeGreaterThanOrEqual(before)
    expect(started).toBeLessThanOrEqual(after)
  })

  it('tells nothing of a pid no process has, nor of one that is no pid', async () => {
    expect.hasAssertions()
    await expect(
      Promise.all([processStartedAt(DEAD_PID), processStartedAt(0)]),
    ).resolves.toStrictEqual([undefined, undefined])
  })
})
