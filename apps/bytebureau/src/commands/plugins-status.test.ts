import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readServerInfo } from '../daemon/server-info.js'
import { stopDaemon } from '../daemon/stop.js'
import { startDaemonProcess, stoppedWithTheTest, type DaemonProcess } from '../testing/daemon.js'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { tempDir, testHome } from '../testing/temp-repo.js'
import { NO_DAEMON } from '../testing/workbench.js'

const WORKSPACE_LOCAL = /^workspace-local\s+\S+\s+loaded\s+workspaceRuntimes:local$/mu
const AGENT_FAKE = /^agent-fake\s+\S+\s+loaded\s+agentProviders:fake$/mu

// What `bytebureau --json` tells of a daemon that has nothing yet, in the order of its keys
const IDLE_DAEMON =
  /^\{"command":"status","daemon":\{"url":"http:\/\/127\.0\.0\.1:\d+","pid":\d+,"version":"[^"]+","startedAt":"[\d:.TZ-]+"\},"projects":0,"sessions":\{"running":0,"waiting":0,"total":0\},"pendingAsks":0\}$/u

// What it tells of the kernel in the process of the command
const IN_PROCESS = [
  'Daemon: not running (in-process)',
  'Projects: 0',
  'Sessions: 0 running, 0 waiting for you, 0 in all',
  'Pending asks: 0',
]

describe('bytebureau plugins ls', () => {
  it('lists the bundled plugins as loaded, with the ports they offer', async () => {
    expect.hasAssertions()
    const home = testHome()
    const daemon = await startDaemonProcess(home)
    const env = { BYTEBUREAU_HOME: home }
    const listed = await runCli(['plugins', 'ls', '--json'], env)
    const text = await runCli(['plugins', 'ls'], env)
    expect(jsonLines(listed.stdout)).toMatchObject([
      {
        command: 'plugins.ls',
        plugins: [
          { name: 'workspace-local', state: 'loaded', ports: ['workspaceRuntimes:local'] },
          { name: 'agent-fake', state: 'loaded', ports: ['agentProviders:fake'] },
          { name: 'agent-claude', state: 'loaded' },
          { name: 'agent-acp', state: 'loaded' },
        ],
      },
    ])
    expect(text.stdout).toMatch(WORKSPACE_LOCAL)
    expect(text.stdout).toMatch(AGENT_FAKE)
    await daemon.stop()
  })

  it('lists them in the process of the command, where no daemon is started', async () => {
    expect.hasAssertions()
    const home = testHome()
    const text = await runCli(['plugins', 'ls', NO_DAEMON], { BYTEBUREAU_HOME: home })
    expect(text.stdout).toMatch(WORKSPACE_LOCAL)
    expect(text.stdout).toMatch(AGENT_FAKE)
    expect(readServerInfo(home).state).toBe('absent')
  })
})

describe('bytebureau with no sub-command', () => {
  it('starts the daemon on demand, and tells what it has as one JSON record', async () => {
    expect.hasAssertions()
    const home = testHome()
    stoppedWithTheTest(home)
    const result = await runCli(['--json'], { BYTEBUREAU_HOME: home })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(IDLE_DAEMON)
    expect(readServerInfo(home).state).toBe('alive')
    await expect(stopDaemon(home)).resolves.toMatchObject({ outcome: 'stopped' })
  })

  it('tells the daemon of the home with its pid and its start, and its counts', async () => {
    expect.hasAssertions()
    const home = testHome()
    const daemon = await startDaemonProcess(home)
    const text = await runCli([], { BYTEBUREAU_HOME: home })
    const [line, ...counts] = text.stdout.trim().split('\n')
    expect(line).toBe(
      `Daemon: ${daemon.url} (pid ${daemon.info.pid}, up since ${daemon.info.startedAt})`,
    )
    expect(counts).toStrictEqual(IN_PROCESS.slice(1))
    await daemon.stop()
  })
})

// The flags that name the daemon from another home: its address, and the file of its token
function naming(daemon: DaemonProcess): string[] {
  const tokenFile = path.join(tempDir('bb-token-'), 'token')
  writeFileSync(tokenFile, daemon.info.token)
  return ['--host', daemon.info.host, '--port', String(daemon.info.port), '--token-file', tokenFile]
}

describe('bytebureau with no sub-command, for a daemon that --host and --port name', () => {
  it('tells it without a pid, which only the home of the daemon knows', async () => {
    expect.hasAssertions()
    const daemon = await startDaemonProcess(testHome())
    const named = naming(daemon)
    const elsewhere = { BYTEBUREAU_HOME: testHome() }
    const text = await runCli(named, elsewhere)
    const json = await runCli([...named, '--json'], elsewhere)
    expect(text.stdout.split('\n')[0]).toBe(
      `Daemon: ${daemon.url} (up since ${daemon.info.startedAt})`,
    )
    expect(jsonLines(json.stdout)).toMatchObject([{ daemon: { url: daemon.url } }])
    expect(json.stdout).not.toContain('"pid"')
    await daemon.stop()
  })
})

describe('bytebureau with no sub-command, in the process of the command', () => {
  it('tells that the kernel runs in the process of the command with --no-daemon, and starts no daemon', async () => {
    expect.hasAssertions()
    const home = testHome()
    const text = await runCli([NO_DAEMON], { BYTEBUREAU_HOME: home })
    expect(text.stdout.trim().split('\n')).toStrictEqual(IN_PROCESS)
    expect(readServerInfo(home).state).toBe('absent')
  })

  it('leaves the daemon out of the JSON record then', async () => {
    expect.hasAssertions()
    const json = await runCli(['--json', NO_DAEMON], { BYTEBUREAU_HOME: testHome() })
    expect(jsonLines(json.stdout)).toStrictEqual([
      {
        command: 'status',
        projects: 0,
        sessions: { running: 0, waiting: 0, total: 0 },
        pendingAsks: 0,
      },
    ])
  })

  it('tells in Czech with --lang cs, which comes before nothing else', async () => {
    expect.hasAssertions()
    const text = await runCli(['--lang', 'cs', NO_DAEMON], { BYTEBUREAU_HOME: testHome() })
    expect(text.stdout.trim().split('\n')).toStrictEqual([
      'Démon: neběží (v procesu)',
      'Projekty: 0',
      'Relace: celkem 0, běžící 0, čekající na Vás 0',
      'Čekající otázky: 0',
    ])
  })

  it('is not told after another command, which would start a daemon of its own', async () => {
    expect.hasAssertions()
    const home = testHome()
    stoppedWithTheTest(home)
    const hello = await runCli(['hello', '--json'], { BYTEBUREAU_HOME: home })
    expect(jsonLines(hello.stdout)).toStrictEqual([
      { command: 'hello', message: 'Hello! ByteBureau is ready.' },
    ])
    expect(readServerInfo(home).state).toBe('absent')
  })
})
