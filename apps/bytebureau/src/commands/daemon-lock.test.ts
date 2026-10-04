import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { lockPath, readServerInfo } from '../daemon/server-info.js'
import { daemonLogPath } from '../daemon/daemon-log.js'
import { stoppedWithTheTest, watchedPort } from '../testing/daemon.js'
import { daemonOfSkewedLock, oldLock, silentLine } from '../testing/old-lock.js'
import { runCli } from '../testing/run-cli.js'
import { testHome } from '../testing/temp-repo.js'

// The pid of the daemon that serves the home, by its record
const daemonPid = (home: string): number | undefined => {
  const record = readServerInfo(home)
  return record.state === 'alive' ? record.info.pid : undefined
}

// A home whose configuration names the port, which a listener of the test holds
const homeOnPort = (port: number): string => {
  const home = testHome()
  stoppedWithTheTest(home)
  writeFileSync(path.join(home, 'config.json'), `${JSON.stringify({ server: { port } })}\n`)
  return home
}

// A home for a daemon a command starts, which ends with the test
const startedHome = (): { readonly home: string; readonly env: Record<string, string> } => {
  const home = testHome()
  stoppedWithTheTest(home)
  return { home, env: { BYTEBUREAU_HOME: home } }
}

// Ps tells the start of a process on macOS and Linux, and only POSIX stops a process with a signal
const POSIX = process.platform !== 'win32'

describe('bytebureau commands and the lock of the home', () => {
  it('take over the lock of a live process of this user that is no daemon of the home, and start one', async () => {
    expect.hasAssertions()
    const { home, env } = startedHome()
    // This test's own pid stands for the process that got the pid of the daemon after a crash or a reboot
    await oldLock(home, process.pid)
    const listed = await runCli(['projects', 'ls', '--json'], env)
    expect([listed.code, listed.stderr]).toStrictEqual([0, ''])
    expect(daemonPid(home)).not.toBe(process.pid)
    expect(readFileSync(lockPath(home), 'utf8')).toBe(String(daemonPid(home)))
  })

  it('fail at once when the daemon they start cannot, naming the log that says why', async () => {
    expect.hasAssertions()
    const taken = await watchedPort()
    const home = homeOnPort(taken.port)
    const since = Date.now()
    const listed = await runCli(['projects', 'ls'], { BYTEBUREAU_HOME: home })
    expect([listed.code, listed.stderr.trim()]).toStrictEqual([
      2,
      `The daemon failed to start; see ${daemonLogPath(home)}`,
    ])
    // Well within the 30 s a start that does not come up is given
    expect(Date.now() - since).toBeLessThan(15_000)
    expect(readFileSync(daemonLogPath(home), 'utf8')).toContain(
      `cannot listen on 127.0.0.1:${taken.port}`,
    )
  })
})

describe('bytebureau serve and a lock whose pid lives on after a crash or a reboot', () => {
  it('starts on the lock of a live process of this user that is no daemon of the home, which it takes over', async () => {
    expect.hasAssertions()
    const { home, env } = startedHome()
    // This test's own pid stands for the process that got the pid of the daemon
    await oldLock(home, process.pid)
    const started = await runCli(['serve', '--port', '0'], env)
    expect(started.code).toBe(0)
    expect(readFileSync(lockPath(home), 'utf8')).toBe(String(daemonPid(home)))
  })

  it('clears with --stop the lock of a live process that is no daemon of the home, and says so', async () => {
    expect.hasAssertions()
    const { home, env } = startedHome()
    await oldLock(home, process.pid)
    const stopped = await runCli(['serve', '--stop'], env)
    const said = `Cleared the stale lock of pid ${process.pid}, which is not a daemon of this home\n`
    expect([stopped.code, stopped.stdout]).toStrictEqual([0, said])
  })

  it.skipIf(!POSIX)(
    'takes over the lock of a process of another user that started after the lock was written',
    async () => {
      expect.hasAssertions()
      const { home, env } = startedHome()
      // Pid 1 started at boot: a lock older than that was written by another process that had the pid before
      await oldLock(home, 1)
      const started = await runCli(['serve', '--port', '0'], env)
      expect(started.code).toBe(0)
      expect(readFileSync(lockPath(home), 'utf8')).toBe(String(daemonPid(home)))
    },
  )
})

// A second daemon of the home in the foreground: it starts only if it takes the lock, and says why it does not
const SECOND = ['serve', '--no-daemonize', '--port', '0']

describe('bytebureau serve and a daemon whose lock reads older than its start, as a clock stepped since shows it', () => {
  it.skipIf(!POSIX)(
    'keeps the lock with the daemon that answers: a second one does not start',
    async () => {
      expect.hasAssertions()
      const { home, daemon } = await daemonOfSkewedLock()
      const second = await runCli(SECOND, { BYTEBUREAU_HOME: home })
      expect([second.code, second.stderr.trim()]).toStrictEqual([
        1,
        `a daemon is already running (pid ${daemon.info.pid})`,
      ])
      expect([readFileSync(lockPath(home), 'utf8'), daemonPid(home)]).toStrictEqual([
        String(daemon.info.pid),
        daemon.info.pid,
      ])
      await expect(daemon.stop()).resolves.toBe(0)
    },
  )

  it.skipIf(!POSIX)(
    'keeps the lock with the daemon stopped a moment into it: --stop names it with the way out, and a second does not start',
    async () => {
      expect.hasAssertions()
      const { home, daemon } = await daemonOfSkewedLock()
      daemon.child.kill('SIGSTOP')
      const env = { BYTEBUREAU_HOME: home }
      const stopped = await runCli(['serve', '--stop'], env)
      const second = await runCli(SECOND, env)
      expect([stopped.code, stopped.stderr.trim(), second.code]).toStrictEqual([
        1,
        silentLine(home, daemon.info.pid),
        1,
      ])
      expect([readFileSync(lockPath(home), 'utf8'), daemonPid(home)]).toStrictEqual([
        String(daemon.info.pid),
        daemon.info.pid,
      ])
      daemon.child.kill('SIGCONT')
      await expect(daemon.stop()).resolves.toBe(0)
    },
  )
})
