import { readFileSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { lockPath, readServerInfo } from '../daemon/server-info.js'
import { daemonLogPath } from '../daemon/spawn.js'
import { stoppedWithTheTest, watchedPort } from '../testing/daemon.js'
import { runCli } from '../testing/run-cli.js'
import { testHome } from '../testing/temp-repo.js'

// A lock left from before a crash or a reboot, naming a process that got the pid since: written an hour ago
const oldLock = (home: string, pid: number): void => {
  writeFileSync(lockPath(home), String(pid))
  const anHourAgo = new Date(Date.now() - 3_600_000)
  utimesSync(lockPath(home), anHourAgo, anHourAgo)
}

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

describe('bytebureau commands and the lock of the home', () => {
  it('take over the lock of a live process of this user that is no daemon of the home, and start one', async () => {
    expect.hasAssertions()
    const home = testHome()
    stoppedWithTheTest(home)
    // This test's own pid stands for the process that got the pid of the daemon after a crash or a reboot
    oldLock(home, process.pid)
    const listed = await runCli(['projects', 'ls', '--json'], { BYTEBUREAU_HOME: home })
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
