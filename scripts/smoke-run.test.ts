import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { devNull, homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import { recordOf, type SmokePlan } from './smoke-agent.js'
import { isThrowawayHome, started, stopperOf, type Throwaway } from './smoke-cli.js'
import { runSmoke } from './smoke-run.js'

// The smoke as CI runs it: on the fake provider, so that it cannot rot between the runs on real agents
const FAKE: SmokePlan = {
  script: 'smoke:fake',
  provider: 'fake',
  profile: undefined,
  variables: [],
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const linesOf = (spy: MockInstance<(...data: unknown[]) => void>): readonly string[] =>
  spy.mock.calls.map(([line]) => String(line))

// What the smoke told on stderr and printed on stdout, through the console that writes both
interface Heard {
  readonly told: () => readonly string[]
  readonly printed: () => readonly string[]
}

function heard(): Heard {
  const told = vi.spyOn(console, 'error').mockReturnValue()
  const printed = vi.spyOn(console, 'log').mockReturnValue()
  return { told: () => linesOf(told), printed: () => linesOf(printed) }
}

// The daemon the smoke started, as the record of serve names it
function daemonOf(printed: readonly string[]): number | undefined {
  const served = printed
    .map((line) => recordOf(line))
    .find((record) => record !== undefined && record['command'] === 'serve')
  const pid = served === undefined ? undefined : served['pid']
  return typeof pid === 'number' ? pid : undefined
}

// A daemon that a failing smoke left is killed with the test; the git of the daemon reads no configuration of whoever runs it
function smokeTest(): Heard {
  vi.stubEnv('GIT_CONFIG_GLOBAL', devNull)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  const output = heard()
  onTestFinished(() => {
    vi.unstubAllEnvs()
    const pid = daemonOf(output.printed())
    if (pid !== undefined && alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  })
  return output
}

// The home and the repository the smoke named in its first line
const throwawaysOf = (told: readonly string[]): readonly string[] => {
  const [first = ''] = told
  const named = /on the throwaway home (?<home>\S+) and repository (?<repo>\S+)$/u.exec(first)
  const { home, repo } = named === null || named.groups === undefined ? {} : named.groups
  return [home, repo].filter((dir) => dir !== undefined)
}

// Whether the daemon and the directories of the smoke are gone
const leftOf = ({ told, printed }: Heard): readonly unknown[] => {
  const pid = daemonOf(printed())
  return [pid !== undefined && alive(pid), throwawaysOf(told()).map((dir) => existsSync(dir))]
}

describe(runSmoke, () => {
  it('runs a turn to its end, then stops, resumes and prompts a second session, and leaves neither its daemon nor its home', async () => {
    expect.hasAssertions()
    const output = smokeTest()
    await expect(runSmoke(FAKE)).resolves.toBe(0)
    expect(output.told()).toStrictEqual(
      expect.arrayContaining([
        'smoke: serve exited 0',
        'smoke: run exited 0',
        'smoke: src/hello.ts in the worktree: yes',
        'smoke: sessions stop exited 0, its run 3, sessions resume 0',
        'smoke: sessions prompt exited 0',
        'smoke: sessions complete exited 0',
        'smoke: serve --stop exited 0',
        'smoke: the home and the repository are gone',
      ]),
    )
    expect(leftOf(output)).toStrictEqual([false, [false, false]])
  })

  it('adds the login profile SMOKE_PROFILE names to its home and runs under it', async () => {
    expect.hasAssertions()
    const output = smokeTest()
    await expect(runSmoke({ ...FAKE, profile: 'fake/work' })).resolves.toBe(0)
    expect(output.told()).toStrictEqual(
      expect.arrayContaining(['smoke: profiles add exited 0', 'smoke: run exited 0']),
    )
    expect(leftOf(output)).toStrictEqual([false, [false, false]])
  })

  it('refuses a profile of another provider before it makes a home or runs anything', async () => {
    expect.hasAssertions()
    const output = heard()
    await expect(runSmoke({ ...FAKE, profile: 'claude/work' })).resolves.toBe(1)
    expect([output.told(), output.printed()]).toStrictEqual([
      ['smoke: SMOKE_PROFILE must be a profile id of fake, such as fake/work, not claude/work'],
      [],
    ])
  })
})

describe(isThrowawayHome, () => {
  it('takes a directory made under the temporary one, and never an unset, empty, relative or other home', () => {
    const root = realpathSync(tmpdir())
    const made = mkdtempSync(path.join(root, 'bb-smoke-test-'))
    onTestFinished(() => {
      rmSync(made, { recursive: true, force: true })
    })
    const homes = [made, undefined, '', 'bb-home', path.join(homedir(), '.bytebureau'), root]
    expect(
      [...homes, path.join(root, 'bb-smoke-gone')].map((home) => isThrowawayHome(home)),
    ).toStrictEqual([true, false, false, false, false, false, false])
  })
})

// A smoke whose commands would run on the home its environment names, unset when none is given
const smokeOn = (dir: string, value?: string): Throwaway => ({
  home: dir,
  repo: dir,
  env: value === undefined ? {} : { BYTEBUREAU_HOME: value },
  stopping: { received: false },
  running: new Set(),
})

describe('the home of a command of the smoke', () => {
  it("is the smoke's own throwaway home: on an unset, empty or other home the command is refused before it runs", () => {
    const prefix = path.join(realpathSync(tmpdir()), 'bb-smoke-test-')
    const home = mkdtempSync(prefix)
    const other = mkdtempSync(prefix)
    onTestFinished(() => {
      rmSync(home, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    })
    const owner = path.join(homedir(), '.bytebureau')
    // --version opens no home: should the guard ever let it through, it still touches none
    const unset = 'refusing to run bytebureau --version on an unset home, ~/.bytebureau'
    expect(() => started(smokeOn(home), ['--version'])).toThrow(unset)
    expect(() => started(smokeOn(home, ''), ['--version'])).toThrow(unset)
    expect(() => started(smokeOn(home, other), ['--version'])).toThrow(`on ${other}`)
    expect(() => started(smokeOn(owner, owner), ['--version'])).toThrow(`on ${owner}`)
  })
})

describe(stopperOf, () => {
  it('stops the smoke at the first held signal, and passes a SIGTERM alone on to the commands it runs', () => {
    const told = vi.spyOn(console, 'error').mockReturnValue()
    const kill = vi.fn<(signal?: NodeJS.Signals | number) => boolean>().mockReturnValue(true)
    const smoke = { stopping: { received: false }, running: new Set([{ kill }]) }
    const stop = stopperOf(smoke)
    stop('SIGINT')
    stop('SIGHUP')
    const before = kill.mock.calls.length
    stop('SIGTERM')
    expect([
      smoke.stopping.received,
      before,
      kill.mock.calls,
      told.mock.calls.length,
    ]).toStrictEqual([true, 0, [['SIGTERM']], 1])
  })
})
