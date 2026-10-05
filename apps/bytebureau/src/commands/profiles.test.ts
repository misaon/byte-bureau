import { describe, expect, it } from 'vitest'
import { jsonLines, listedUnder } from '../testing/json-lines.js'
import { runCli, runCliWithStdin, type CliResult } from '../testing/run-cli.js'
import { benchWithDaemon, type Bench, type Env } from '../testing/session-bench.js'
import { testHome } from '../testing/temp-repo.js'
import { NO_DAEMON, ON_FAKE, sessionIdIn, workbench } from '../testing/workbench.js'

// The JSON record a command printed under its name
function recordOf(stdout: string, command: string): Record<string, unknown> | undefined {
  return jsonLines(stdout).find((line) => line['command'] === command)
}

interface TwoProfiles {
  readonly codes: readonly number[]
  readonly defaults: readonly unknown[]
}

// The login profile fake/work, then the API-key profile fake/key, made the default of the provider
async function twoProfiles(env: Env): Promise<TwoProfiles> {
  const work = await runCli(['profiles', 'add', 'fake', 'work'], env)
  const key = await runCliWithStdin(['profiles', 'add', 'fake', 'key', '--api-key'], env, 'sk-1\n')
  const used = await runCli(['profiles', 'use', 'fake/key'], env)
  const listed = await runCli(['profiles', 'ls', '--json'], env)
  const defaults = listedUnder(listed.stdout, 'profiles')
    .filter((profile) => profile['isDefault'] === true)
    .map((profile) => profile['id'])
  return { codes: [work.code, key.code, used.code], defaults }
}

// A run of the slow script under the profile, which Ctrl-C stops once its turn works: its session can resume
async function stoppedRunUnder(bench: Bench, profile: string): Promise<CliResult> {
  const args = ['run', 'wait', '--project', bench.repo, ...ON_FAKE, '--profile', profile, '--json']
  const env = { ...bench.env, BYTEBUREAU_FAKE_SCRIPT: 'slow' }
  const run = await runCli(args, env, { afterStdout: '"turn.started"', signal: 'SIGINT' })
  return run
}

interface Released {
  readonly id: string
  readonly shown: string
  readonly completed: string
  readonly codes: readonly number[]
}

// The stopped session is resumed and completed, which lets go of its profile; then fake/key goes, fake/work with its directory, and fake/work once more
async function releasedAndRemoved({ home, env }: Bench): Promise<Released> {
  const id = await sessionIdIn(home, [])
  const shown = await runCli(['sessions', 'show', id], env)
  const resumed = await runCli(['sessions', 'resume', id], env)
  const completed = await runCli(['sessions', 'complete', id], env)
  const key = await runCli(['profiles', 'rm', 'fake/key'], env)
  const work = await runCli(['profiles', 'rm', 'fake/work', '--purge'], env)
  const again = await runCli(['profiles', 'rm', 'fake/work'], env)
  const codes = [resumed.code, completed.code, key.code, work.code, again.code]
  return { id, shown: shown.stdout, completed: completed.stdout, codes }
}

describe('bytebureau profiles through the daemon', () => {
  it('adds a login profile, lists it as the default and tells its status', async () => {
    expect.hasAssertions()
    const { env, daemon } = await benchWithDaemon()
    const added = await runCli(['profiles', 'add', 'fake', 'work', '--json'], env)
    const listed = await runCli(['profiles', 'ls'], env)
    const status = await runCli(['profiles', 'status', 'fake/work', '--json'], env)
    expect(added.code).toBe(0)
    expect(recordOf(added.stdout, 'profiles.add')).toMatchObject({
      profile: { id: 'fake/work', kind: 'login', isDefault: true },
    })
    expect(listed.stdout).toMatch(/^fake\/work {2}fake {2}login {2}default {2}\S/mu)
    expect(recordOf(status.stdout, 'profiles.status')).toMatchObject({
      statuses: [{ profileId: 'fake/work', state: 'loggedIn' }],
    })
    await daemon.stop()
  })

  it('reads an API key from stdin, never from the arguments, and refuses an empty one', async () => {
    expect.hasAssertions()
    const { env, daemon } = await benchWithDaemon()
    const args = ['profiles', 'add', 'fake', 'key', '--api-key', '--json']
    const keyed = await runCliWithStdin(args, env, 'sk-from-stdin\n')
    const empty = await runCliWithStdin(
      ['profiles', 'add', 'fake', 'other', '--api-key'],
      env,
      '\n',
    )
    expect([keyed.code, recordOf(keyed.stdout, 'profiles.add')]).toMatchObject([
      0,
      { profile: { id: 'fake/key', kind: 'api_key' } },
    ])
    expect(keyed.stdout).not.toContain('sk-from-stdin')
    expect([empty.code, empty.stderr]).toStrictEqual([
      1,
      expect.stringContaining('--api-key needs a key'),
    ])
    await daemon.stop()
  })
})

describe('bytebureau profiles and the sessions that run under them', () => {
  it('moves the default, refuses to remove the profile of a session that can resume, and removes it once the session is completed', async () => {
    expect.hasAssertions()
    const bench = await benchWithDaemon()
    await expect(twoProfiles(bench.env)).resolves.toStrictEqual({
      codes: [0, 0, 0],
      defaults: ['fake/key'],
    })
    const run = await stoppedRunUnder(bench, 'fake/work')
    const held = await runCli(['profiles', 'rm', 'fake/work'], bench.env)
    expect([run.code, held.code, held.stderr]).toStrictEqual([
      3,
      1,
      expect.stringContaining(
        '1 session(s) still run under it or can resume; complete or remove them first',
      ),
    ])
    const released = await releasedAndRemoved(bench)
    expect([released.shown, released.completed, released.codes]).toStrictEqual([
      expect.stringMatching(/^profile\s+fake\/work$/mu),
      `Completed ${released.id}\n`,
      [0, 0, 0, 0, 1],
    ])
    await bench.daemon.stop()
  })
})

describe('bytebureau profiles in the process of the command', () => {
  it('tells that there is nothing, adds a profile and refuses one nobody holds in the words of the kernel', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_HOME: testHome() }
    const none = await runCli(['profiles', 'ls', '--lang', 'cs', NO_DAEMON], env)
    const unchecked = await runCli(['profiles', 'status', NO_DAEMON], env)
    const added = await runCli(['profiles', 'add', 'fake', 'work', NO_DAEMON], env)
    const missing = await runCli(['profiles', 'rm', 'fake/nope', NO_DAEMON], env)
    expect([none.stdout, unchecked.stdout]).toStrictEqual([
      'Žádné profily\n',
      'No profiles to check\n',
    ])
    expect([added.code, added.stdout]).toStrictEqual([0, 'Profile fake/work added\n'])
    expect([missing.code, missing.stderr]).toStrictEqual([1, 'no profile "fake/nope"\n'])
  })

  it('refuses a run under a profile nobody holds with exit code 4', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const args = ['run', 'x', '--project', repo, ...ON_FAKE, '--profile', 'fake/nope', '--yes']
    const run = await runCli([...args, NO_DAEMON], { BYTEBUREAU_HOME: home })
    expect([run.code, run.stderr]).toStrictEqual([
      4,
      'ProfileError: no profile "fake/nope" (not_found)\n',
    ])
  })
})

const TYPED = 'sk-typed-123'

describe('bytebureau profiles add and a key typed as an argument', () => {
  it('refuses it before anything is read or sent, never repeating it, and adds nothing', async () => {
    expect.hasAssertions()
    const env = { BYTEBUREAU_HOME: testHome() }
    const before = await runCli(
      ['profiles', 'add', 'fake', '--api-key', TYPED, 'key', NO_DAEMON],
      env,
    )
    const after = await runCli(
      ['profiles', 'add', 'fake', 'key', '--api-key', TYPED, NO_DAEMON],
      env,
    )
    const listed = await runCli(['profiles', 'ls', '--json', NO_DAEMON], env)
    const refusal =
      'The API key is never an argument: pass --api-key alone and type it at the prompt, or pipe it on stdin\n'
    expect([before.code, before.stderr, after.code, after.stderr]).toStrictEqual([
      1,
      refusal,
      1,
      refusal,
    ])
    expect([before.stdout, after.stdout].join('')).not.toContain(TYPED)
    expect(listedUnder(listed.stdout, 'profiles')).toStrictEqual([])
  })
})
