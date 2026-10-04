import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import { readServerInfo } from './daemon/server-info.js'
import { freePort, stoppedWithTheTest } from './testing/daemon.js'
import { runCli } from './testing/run-cli.js'
import { testHome } from './testing/temp-repo.js'
import { PROMPT, SCRIPTED, workbench } from './testing/workbench.js'

const ESCAPE = '\u001B'

describe('bytebureau CLI', () => {
  it('prints a semantic version', async () => {
    expect.hasAssertions()
    const { stdout, code } = await runCli(['--version'])
    expect(code).toBe(0)
    expect(stdout).toMatch(/\d+\.\d+\.\d+/u)
  })

  it('lists the hello command in help', async () => {
    expect.hasAssertions()
    const { stdout, code } = await runCli(['--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('hello')
  })

  it('lists the kernel commands in help', async () => {
    expect.hasAssertions()
    const { stdout } = await runCli(['--help'])
    const commands = stripVTControlCharacters(stdout)
    for (const name of [
      'run',
      'config',
      'projects',
      'workspaces',
      'serve',
      'sessions',
      'ask',
      'plugins',
    ]) {
      expect(commands, name).toMatch(new RegExp(`^\\s+${name}\\s+\\S`, 'mu'))
    }
  })

  it('lists the global flags in the help of the bare command, which tells the status', async () => {
    expect.hasAssertions()
    const { stdout } = await runCli(['--help'])
    expect(stdout).toContain('--json')
    expect(stdout).toContain('--no-daemon')
  })
})

describe('bytebureau hello', () => {
  it('greets in Czech when --lang cs is passed', async () => {
    expect.hasAssertions()
    const { stdout, code } = await runCli(['hello', 'Ondřej', '--lang', 'cs'])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('Ahoj, Ondřej! ByteBureau je připraveno.')
  })

  it('greets anonymously in English by default', async () => {
    expect.hasAssertions()
    const { stdout } = await runCli(['hello'])
    expect(stdout.trim()).toBe('Hello! ByteBureau is ready.')
  })

  it('emits JSON without ANSI codes even when FORCE_COLOR is set', async () => {
    expect.hasAssertions()
    const { stdout } = await runCli(['hello', 'Ondřej', '--json'], { FORCE_COLOR: '1' })
    expect(stdout).not.toContain(ESCAPE)
    expect(JSON.parse(stdout)).toStrictEqual({
      command: 'hello',
      message: 'Hello, Ondřej! ByteBureau is ready.',
    })
  })

  it('falls back to English with a warning for an unsupported language', async () => {
    expect.hasAssertions()
    const { stdout, stderr, code } = await runCli(['hello', '--lang', 'de'])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('Hello! ByteBureau is ready.')
    expect(stderr).toContain('Unsupported language "de"')
  })

  it('exits with code 1 for an unknown command', async () => {
    expect.hasAssertions()
    const { code } = await runCli(['nonsense'])
    expect(code).toBe(1)
  })
})

describe('bytebureau global flags', () => {
  it('shows --log-level, as it is typed, in the help of a command', async () => {
    expect.hasAssertions()
    const { stdout } = await runCli(['run', '--help'])
    expect(stdout).toContain('--log-level')
    expect(stdout).not.toContain('--logLevel')
  })

  it('keeps a flag that follows a bare --debug a flag', async () => {
    expect.hasAssertions()
    const { stdout, code } = await runCli(['hello', '--debug', '--json'])
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toStrictEqual({
      command: 'hello',
      message: 'Hello! ByteBureau is ready.',
    })
  })
})

describe('bytebureau global flags before the sub-command', () => {
  it('hands --lang to the sub-command: it greets in Czech', async () => {
    expect.hasAssertions()
    const { stdout, code } = await runCli(['--lang', 'cs', 'hello'])
    expect([code, stdout.trim()]).toStrictEqual([0, 'Ahoj! ByteBureau je připraveno.'])
  })

  it('takes the flags on both sides of the sub-command', async () => {
    expect.hasAssertions()
    const { stdout } = await runCli(['--json', 'hello', '--lang', 'cs'])
    expect(JSON.parse(stdout)).toStrictEqual({
      command: 'hello',
      message: 'Ahoj! ByteBureau je připraveno.',
    })
  })

  it('keeps --host and --port a daemon that is never started: exit 2 and the url, and no daemon', async () => {
    expect.hasAssertions()
    const home = testHome()
    // Were the flags dropped, the command would start a daemon of its own on demand
    stoppedWithTheTest(home)
    const port = await freePort()
    const flags = ['--host', '127.0.0.1', '--port', String(port)]
    const result = await runCli([...flags, 'projects', 'ls'], { BYTEBUREAU_HOME: home })
    expect([result.code, result.stderr.trim()]).toStrictEqual([
      2,
      `cannot reach the daemon at http://127.0.0.1:${port}/api/v1/projects`,
    ])
    expect(readServerInfo(home).state).toBe('absent')
  })
})

describe('bytebureau global flags before a sub-command that has sub-commands', () => {
  it('hands them on to the sub-command of the sub-command, which parses its flags', async () => {
    expect.hasAssertions()
    const home = testHome()
    // Were the flags dropped, the command would start a daemon of its own on demand
    stoppedWithTheTest(home)
    const env = { BYTEBUREAU_HOME: home }
    const empty = await runCli(['--json', '--no-daemon', 'sessions', 'ls'], env)
    const czech = await runCli(['--lang', 'cs', '--no-daemon', 'sessions', 'ls'], env)
    expect(JSON.parse(empty.stdout)).toStrictEqual({ command: 'sessions.ls', sessions: [] })
    expect(czech.stdout.trim()).toBe('Žádné relace')
  })

  it('runs the kernel in the process of the command with --no-daemon before the sub-command', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    stoppedWithTheTest(home)
    const run = ['--no-daemon', 'run', PROMPT, '--project', repo, ...SCRIPTED]
    const result = await runCli(run, { BYTEBUREAU_HOME: home })
    expect([result.code, readServerInfo(home).state]).toStrictEqual([0, 'absent'])
  })
})
