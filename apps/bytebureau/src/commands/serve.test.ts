import { existsSync, readFileSync, statSync } from 'node:fs'
import { serverUrl } from '@bytebureau/protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { readServerInfo, serverInfoPath } from '../daemon/server-info.js'
import { daemonLogPath } from '../daemon/spawn.js'
import { stopDaemon } from '../daemon/stop.js'
import { startDaemonProcess } from '../testing/daemon.js'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { tempDir } from '../testing/temp-repo.js'

const modeOf = (file: string): number => statSync(file).mode % 0o1000

const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } })

// What --json prints for the daemon of the home: where it listens, its pid and its version, never its token
const describedDaemon = (home: string): Record<string, unknown> => {
  const record = readServerInfo(home)
  return record.state === 'alive'
    ? {
        command: 'serve',
        url: serverUrl(record.info),
        pid: record.info.pid,
        version: record.info.version,
      }
    : { state: record.state }
}

// A detached daemon of the home ends with the test, should an assertion fail before the test stops it
const stoppedWithTheTest = (home: string): Record<string, string> => {
  onTestFinished(async () => {
    await stopDaemon(home)
  })
  return { BYTEBUREAU_HOME: home }
}

describe('bytebureau serve --no-daemonize', () => {
  it('writes server.json for the user alone, on the loopback, and removes it on SIGTERM', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const daemon = await startDaemonProcess(home)
    expect(modeOf(serverInfoPath(home))).toBe(0o600)
    expect(daemon.info.token).toMatch(/^[0-9a-f]{64}$/u)
    expect(daemon.info.host).toBe('127.0.0.1')
    // The line follows the record, so it may still be on its way through the pipe
    await vi.waitFor(() => {
      expect(daemon.stdout()).toBe(`Daemon listening on ${daemon.url}\n`)
    })
    expect([await daemon.stop(), existsSync(serverInfoPath(home))]).toStrictEqual([0, false])
  })

  it('answers health to anyone and the rest of the API only with the token', async () => {
    expect.hasAssertions()
    const daemon = await startDaemonProcess(tempDir('bb-home-'))
    const health = await fetch(`${daemon.url}/api/v1/health`)
    await expect(health.json()).resolves.toMatchObject({
      status: 'ok',
      startedAt: daemon.info.startedAt,
    })
    const denied = await fetch(`${daemon.url}/api/v1/projects`)
    const allowed = await fetch(`${daemon.url}/api/v1/projects`, bearer(daemon.info.token))
    expect([health.status, denied.status, allowed.status]).toStrictEqual([200, 401, 200])
    await expect(allowed.json()).resolves.toStrictEqual([])
    await expect(daemon.stop()).resolves.toBe(0)
  })

  it('keeps the token across a restart', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const first = await startDaemonProcess(home)
    await expect(first.stop()).resolves.toBe(0)
    const second = await startDaemonProcess(home)
    expect(second.info.token).toBe(first.info.token)
    await expect(second.stop()).resolves.toBe(0)
  })
})

describe('bytebureau serve --no-daemonize refusals', () => {
  it('refuses a second daemon on the same home with exit 1 and the pid of the first', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const daemon = await startDaemonProcess(home)
    const second = await runCli(['serve', '--no-daemonize', '--port', '0'], {
      BYTEBUREAU_HOME: home,
    })
    const refusal = `a daemon is already running (pid ${daemon.info.pid})`
    expect([second.code, second.stderr.trim()]).toStrictEqual([1, refusal])
    await expect(daemon.stop()).resolves.toBe(0)
  })

  it('refuses a port that is taken with exit 1 and one line', async () => {
    expect.hasAssertions()
    const daemon = await startDaemonProcess(tempDir('bb-home-'))
    const port = String(daemon.info.port)
    const other = await runCli(['serve', '--no-daemonize', '--port', port], {
      BYTEBUREAU_HOME: tempDir('bb-home-'),
    })
    expect([other.code, other.stderr.trim()]).toStrictEqual([1, `port ${port} is already in use`])
    await expect(daemon.stop()).resolves.toBe(0)
  })

  it('refuses a port that is no port as a usage error', async () => {
    expect.hasAssertions()
    const refused = await runCli(['serve', '--port', '80a'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('--port takes a whole number from 0 to 65535, not 80a')
  })
})

describe('bytebureau serve (detached) and serve --stop', () => {
  it('starts the daemon detached on the loopback and reports its url, pid and version as JSON', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const started = await runCli(['serve', '--port', '0', '--json'], stoppedWithTheTest(home))
    expect(started.code).toBe(0)
    expect(jsonLines(started.stdout)).toStrictEqual([describedDaemon(home)])
    expect(readServerInfo(home)).toMatchObject({ state: 'alive', info: { host: '127.0.0.1' } })
  })

  it('names the daemon that serves the home already instead of starting another', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const env = stoppedWithTheTest(home)
    await expect(runCli(['serve', '--port', '0'], env)).resolves.toMatchObject({ code: 0 })
    const { url, pid } = describedDaemon(home)
    const again = await runCli(['serve', '--port', '0'], env)
    const named = `Daemon already running on ${String(url)} (pid ${String(pid)})\n`
    expect([again.code, again.stdout]).toStrictEqual([0, named])
  })

  it('ends the daemon with --stop, and then finds none to stop', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const env = stoppedWithTheTest(home)
    await expect(runCli(['serve', '--port', '0'], env)).resolves.toMatchObject({ code: 0 })
    const { pid } = describedDaemon(home)
    const stopped = await runCli(['serve', '--stop'], env)
    const said = `Stopped daemon (pid ${String(pid)})\n`
    expect([stopped.code, stopped.stdout, readServerInfo(home).state]).toStrictEqual([
      0,
      said,
      'absent',
    ])
    const none = await runCli(['serve', '--stop'], env)
    expect([none.code, none.stdout]).toStrictEqual([0, 'No daemon is running\n'])
  })
})

describe('bytebureau serve (detached) that cannot start', () => {
  it('gives up on a daemon that does not come up, naming the log that says why', async () => {
    expect.hasAssertions()
    const daemon = await startDaemonProcess(tempDir('bb-home-'))
    const home = tempDir('bb-home-')
    const port = String(daemon.info.port)
    const started = await runCli(['serve', '--port', port], stoppedWithTheTest(home))
    const gaveUp = `The daemon did not come up in time; see ${daemonLogPath(home)}`
    expect([started.code, started.stderr.trim()]).toStrictEqual([1, gaveUp])
    expect(readFileSync(daemonLogPath(home), 'utf8')).toContain(`port ${port} is already in use`)
    await expect(daemon.stop()).resolves.toBe(0)
  })
})
