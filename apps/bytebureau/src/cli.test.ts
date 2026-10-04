import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import { readServerInfo } from './daemon/server-info.js'
import { freePort, stoppedWithTheTest } from './testing/daemon.js'
import { runCli } from './testing/run-cli.js'
import { testHome, tokenFile } from './testing/temp-repo.js'
import { NO_DAEMON, PROMPT, SCRIPTED, workbench } from './testing/workbench.js'

const ESCAPE = '\u001B'
const BEFORE = 'before the sub-command'
const BETWEEN = 'between the sub-command and its own'

// The arguments of a call to the ls of a group, with flags that stand before the group or between the group and the ls
function lsWith(group: string, place: string, flags: readonly string[]): string[] {
  return place === BEFORE ? [...flags, group, 'ls'] : [group, ...flags, 'ls']
}

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

  it('lets the flag given later win, as it does with no flag before the sub-command', async () => {
    expect.hasAssertions()
    const { stdout, code } = await runCli(['--lang', 'cs', 'hello', '--lang', 'en'])
    expect([code, stdout.trim()]).toStrictEqual([0, 'Hello! ByteBureau is ready.'])
  })

  it.each([BEFORE, BETWEEN])(
    'keeps --host and --port %s a daemon that is never started: exit 2 and the url, and no daemon',
    async (place) => {
      expect.hasAssertions()
      const home = testHome()
      // Were the flags dropped, the command would start a daemon of its own on demand
      stoppedWithTheTest(home)
      const port = await freePort()
      const named = ['--host', '127.0.0.1', '--port', String(port), '--token-file', tokenFile()]
      const argv = lsWith('projects', place, named)
      const result = await runCli(argv, { BYTEBUREAU_HOME: home })
      expect([result.code, result.stderr.trim()]).toStrictEqual([
        2,
        `cannot reach the daemon at http://127.0.0.1:${port}/api/v1/projects`,
      ])
      expect(readServerInfo(home).state).toBe('absent')
    },
  )
})

describe('bytebureau global flags before a sub-command that has sub-commands', () => {
  it.each([BEFORE, BETWEEN])(
    'hands the flags %s on to its own, which parses them',
    async (place) => {
      expect.hasAssertions()
      const home = testHome()
      // Were the flags dropped, the command would start a daemon of its own on demand
      stoppedWithTheTest(home)
      const env = { BYTEBUREAU_HOME: home }
      const empty = await runCli(lsWith('sessions', place, ['--json', NO_DAEMON]), env)
      const czech = await runCli(lsWith('sessions', place, ['--lang', 'cs', NO_DAEMON]), env)
      expect(JSON.parse(empty.stdout)).toStrictEqual({ command: 'sessions.ls', sessions: [] })
      expect(czech.stdout.trim()).toBe('Žádné relace')
      expect(readServerInfo(home).state).toBe('absent')
    },
  )

  it('hands on the flags of both levels at once', async () => {
    expect.hasAssertions()
    const home = testHome()
    stoppedWithTheTest(home)
    const argv = ['--lang', 'cs', 'sessions', NO_DAEMON, 'ls']
    const { stdout, code } = await runCli(argv, { BYTEBUREAU_HOME: home })
    expect([code, stdout.trim(), readServerInfo(home).state]).toStrictEqual([
      0,
      'Žádné relace',
      'absent',
    ])
  })

  it('runs the kernel in the process of the command with --no-daemon before the sub-command', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    stoppedWithTheTest(home)
    const run = [NO_DAEMON, 'run', PROMPT, '--project', repo, ...SCRIPTED]
    const result = await runCli(run, { BYTEBUREAU_HOME: home })
    expect([result.code, readServerInfo(home).state]).toStrictEqual([0, 'absent'])
  })
})

describe('bytebureau commands that talk to no daemon', () => {
  it.each([
    ['hello', ['hello', '--host', '127.0.0.1'], '--host'],
    ['config schema', ['--no-daemon', 'config', 'schema'], '--no-daemon'],
    ['serve', ['serve', '--token-file', 'token'], '--token-file'],
  ])('refuse the flags that choose one: %s', async (command, argv, flag) => {
    expect.hasAssertions()
    const home = testHome()
    const refused = await runCli(argv, { BYTEBUREAU_HOME: home })
    expect([refused.code, readServerInfo(home).state]).toStrictEqual([1, 'absent'])
    expect(refused.stderr).toContain(`${command} talks to no daemon: it takes no ${flag}`)
  })

  it('take the value of a flag that names a leaf for the value, and start no daemon for it', async () => {
    expect.hasAssertions()
    const home = testHome()
    // Were the value taken for the leaf, prune would run with the flag dropped and start a daemon of the home
    stoppedWithTheTest(home)
    const refused = await runCli(['workspaces', '--host', 'prune'], { BYTEBUREAU_HOME: home })
    expect([refused.code, readServerInfo(home).state]).toStrictEqual([1, 'absent'])
    expect(refused.stderr).toContain('No command specified.')
  })

  it('leaves the flags that choose a daemon out of the help of serve', async () => {
    expect.hasAssertions()
    const { stdout } = await runCli(['serve', '--help'])
    const usage = stripVTControlCharacters(stdout)
    expect(usage).toContain('--no-daemonize')
    expect(usage).not.toMatch(/--(?:no-)?daemon\b|--token-file/u)
  })
})
