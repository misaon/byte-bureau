import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readServerInfo, writeServerInfo } from '../daemon/server-info.js'
import { stopDaemon } from '../daemon/stop.js'
import { freePort, startDaemonProcess, stoppedWithTheTest } from '../testing/daemon.js'
import { eventLines, jsonLines } from '../testing/json-lines.js'
import { runCli, type CliResult } from '../testing/run-cli.js'
import { createTempRepo, tempDir, testHome } from '../testing/temp-repo.js'
import { PROMPT, projectIdIn, SCRIPTED, workbench, worktreesOf } from '../testing/workbench.js'

// Without --yes and off a terminal the run waits on the question of the fake provider
const WAITING = ['--provider', 'fake', '--json']

// A run of the prompt on the repository, through the daemon of the home unless the flags say otherwise
async function runOn(repo: string, home: string, flags = SCRIPTED): Promise<CliResult> {
  const result = await runCli(['run', PROMPT, '--project', repo, ...flags], {
    BYTEBUREAU_HOME: home,
  })
  return result
}

describe('bytebureau run through the daemon', () => {
  it('runs the fake provider end to end over the API and streams NDJSON events', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const result = await runOn(repo, home)
    const types = jsonLines(result.stdout).map((record) => record['type'])
    expect([result.code, result.stderr]).toStrictEqual([0, ''])
    expect(types).toStrictEqual(expect.arrayContaining(['session.created', 'ask.requested']))
    expect(types.at(-1)).toBe('session.completed')
    expect(existsSync(worktreesOf(repo))).toBe(true)
    await daemon.stop()
  })

  it('lists the project of the run, and refuses to remove it while it has a session', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    await runOn(repo, home)
    const listed = await runCli(['projects', 'ls', '--json'], { BYTEBUREAU_HOME: home })
    const id = await projectIdIn(home, [])
    const removed = await runCli(['projects', 'rm', id], { BYTEBUREAU_HOME: home })
    expect(jsonLines(listed.stdout)).toMatchObject([{ projects: [{ id, path: repo }] }])
    // The kernel's refusal comes as a problem; it is told as the in-process one is, with exit code 1
    expect([removed.code, removed.stderr.trim()]).toStrictEqual([
      1,
      `project ${path.basename(repo)} still has 1 session`,
    ])
    await daemon.stop()
  })
})

describe('bytebureau projects through the daemon', () => {
  it('refuses a path that is no git repository, with exit code 1 and the detail of the problem', async () => {
    expect.hasAssertions()
    const home = testHome()
    const daemon = await startDaemonProcess(home)
    const plain = tempDir('bb-plain-')
    const added = await runCli(['projects', 'add', plain], { BYTEBUREAU_HOME: home })
    expect([added.code, added.stderr.trim()]).toStrictEqual([
      1,
      `${plain} is not inside a git repository`,
    ])
    await daemon.stop()
  })

  it('refuses a project that is not there as a refusal, with exit code 1 and the detail of the problem', async () => {
    expect.hasAssertions()
    const home = testHome()
    const daemon = await startDaemonProcess(home)
    const missing = '0192f0a0-0000-7000-8000-000000000009'
    const removed = await runCli(['projects', 'rm', missing], { BYTEBUREAU_HOME: home })
    expect([removed.code, removed.stderr.trim()]).toStrictEqual([1, `no project ${missing}`])
    await daemon.stop()
  })
})

describe('bytebureau run and the daemon of its home', () => {
  it('starts the daemon on demand when none runs, and leaves it running', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    stoppedWithTheTest(home)
    expect(readServerInfo(home).state).toBe('absent')
    const result = await runOn(repo, home)
    expect(result.code).toBe(0)
    expect(readServerInfo(home).state).toBe('alive')
    await expect(stopDaemon(home)).resolves.toMatchObject({ outcome: 'stopped' })
  })

  it('refuses --no-daemon while the daemon is alive, with exit 1 and the way out', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const result = await runOn(repo, home, ['--no-daemon', ...SCRIPTED])
    expect(result.code).toBe(1)
    expect(result.stderr.trim()).toBe(
      `A daemon is running on ${daemon.url} (pid ${daemon.info.pid}); drop --no-daemon or stop it with bytebureau serve --stop`,
    )
    await daemon.stop()
  })

  it('still runs in-process with --no-daemon when no daemon is alive', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runOn(repo, home, ['--no-daemon', ...SCRIPTED])
    expect(result.code).toBe(0)
    expect(readServerInfo(home).state).toBe('absent')
  })
})

// The record of a daemon that crashed, its pid taken over: this test's pid is alive, and nothing listens on the port
async function writeUnansweredRecord(home: string): Promise<void> {
  const port = await freePort()
  const token = 'a'.repeat(64)
  writeServerInfo(home, {
    version: '0',
    host: '127.0.0.1',
    port,
    pid: process.pid,
    token,
    startedAt: 's',
  })
}

describe('bytebureau commands and a record whose daemon does not answer', () => {
  it('trust no record but an answer: they start a daemon on demand', async () => {
    expect.hasAssertions()
    const home = testHome()
    stoppedWithTheTest(home)
    await writeUnansweredRecord(home)
    const listed = await runCli(['projects', 'ls', '--json'], { BYTEBUREAU_HOME: home })
    const record = readServerInfo(home)
    expect([listed.code, record.state]).toStrictEqual([0, 'alive'])
    expect(record).not.toMatchObject({ info: { pid: process.pid } })
    await expect(stopDaemon(home)).resolves.toMatchObject({ outcome: 'stopped' })
  })
})

describe('bytebureau commands and a daemon named on the command line', () => {
  it('fail with exit 2 and the url when --host and --port name a daemon that is not there', async () => {
    expect.hasAssertions()
    const home = testHome()
    const result = await runCli(['projects', 'ls', '--host', '127.0.0.1', '--port', '9'], {
      BYTEBUREAU_HOME: home,
    })
    expect(result.code).toBe(2)
    expect(result.stderr.trim()).toBe(
      'cannot reach the daemon at http://127.0.0.1:9/api/v1/projects',
    )
    expect(readServerInfo(home).state).toBe('absent')
  })
})

describe('bytebureau run beside another run', () => {
  it('runs two sessions through one daemon at the same time, and the daemon knows both', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const other = createTempRepo()
    const daemon = await startDaemonProcess(home)
    const results = await Promise.all([runOn(repo, home), runOn(other, home)])
    expect(results.map((result) => result.code)).toStrictEqual([0, 0])
    expect([repo, other].map((each) => readdirSync(worktreesOf(each)).length)).toStrictEqual([1, 1])
    const listed = await runCli(['workspaces', 'ls', '--json'], { BYTEBUREAU_HOME: home })
    expect(jsonLines(listed.stdout)).toMatchObject([
      { workspaces: [{ sessionStatus: 'completed' }, { sessionStatus: 'completed' }] },
    ])
    await daemon.stop()
  })
})

describe('bytebureau run through the daemon when it is stopped or the daemon is gone', () => {
  it('stops the session on SIGTERM while it waits on an ask, and exits 3', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const result = await runCli(
      ['run', PROMPT, '--project', repo, ...WAITING],
      { BYTEBUREAU_HOME: home },
      { signal: 'SIGTERM', afterStdout: '"type":"session.waiting"' },
    )
    expect(result.code).toBe(3)
    expect(eventLines(result.stdout).at(-1)).toMatchObject({ type: 'session.stopped' })
    await daemon.stop()
  })

  it('ends a run with exit 2 and the url when the daemon dies while the run waits on an ask', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const daemon = await startDaemonProcess(home)
    const result = await runCli(
      ['run', PROMPT, '--project', repo, ...WAITING],
      { BYTEBUREAU_HOME: home },
      { signal: 'SIGKILL', afterStdout: '"type":"ask.requested"', target: daemon.child },
    )
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(
      /^cannot reach the daemon at http:\/\/127\.0\.0\.1:\d+\/api\/v1\/events/mu,
    )
  }, 30_000)
})
