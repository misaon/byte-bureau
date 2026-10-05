import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { firstField, jsonLines, listedUnder } from '../testing/json-lines.js'
import { fakeAcpPreset, writeConfig } from '../testing/repo-config.js'
import { runCli, runCliWithStdin, type CliResult } from '../testing/run-cli.js'
import { asksWaiting, benchWithDaemon, untilStatus, type Bench } from '../testing/session-bench.js'
import { configureHome } from '../testing/temp-repo.js'
import { PROMPT, sessionIdIn, worktreesOf } from '../testing/workbench.js'

// A run on the custom ACP agent through the daemon of the home, its events as JSON lines
const ON_CUSTOM = ['--provider', 'acp:custom', '--json']

// What a run prints once the agent asks for its permission
const ASKED = '"type":"ask.requested"'

// What to install and how to log in, as the codex preset tells them
const CODEX_HINTS =
  'install it with: npm install -g @agentclientprotocol/codex-acp; then log in with: codex login'

const CANARY = 'sk-acp-canary-5d81e0b4'

// A daemon for the home of a test, and a repository whose project file configures the providers
async function benchOn(providers: Readonly<Record<string, unknown>>): Promise<Bench> {
  const bench = await benchWithDaemon()
  writeConfig(bench.repo, { providers })
  return bench
}

// The custom provider runs the fake ACP agent, whose hello script asks one permission and then writes src/hello.ts
async function onTheFake(): Promise<Bench> {
  const bench = await benchOn({ 'acp:custom': fakeAcpPreset() })
  return bench
}

// The file the agent writes, in the one worktree of the repository
function helloIn(repo: string): string {
  const [worktree = ''] = readdirSync(worktreesOf(repo))
  return path.join(worktreesOf(repo), worktree, 'src', 'hello.ts')
}

const typesOf = (run: CliResult): readonly unknown[] =>
  jsonLines(run.stdout).map((event) => event['type'])

// The events of a run from the permission its agent asked for on
function fromTheAsk(run: CliResult): readonly unknown[] {
  const types = typesOf(run)
  return types.slice(types.indexOf('ask.requested'))
}

// A run whose agent waits on its permission: off a terminal and without --yes nobody answers it
interface Waiting extends Bench {
  readonly run: Promise<CliResult>
  readonly sessionId: string
}

async function waitingOnPermission(): Promise<Waiting> {
  const bench = await onTheFake()
  const run = runCli(['run', PROMPT, '--project', bench.repo, ...ON_CUSTOM], bench.env)
  const listed = await asksWaiting(bench.env, Date.now() + 15_000)
  return { ...bench, run, sessionId: firstField(listed, 'asks', 'sessionId') }
}

describe('bytebureau run on an ACP agent through the daemon', () => {
  it('runs a prompt through an ACP agent over the daemon: the permission is answered by --yes, the file lands in the worktree, exit 0', async () => {
    expect.hasAssertions()
    const bench = await onTheFake()
    const args = ['run', PROMPT, '--project', bench.repo, ...ON_CUSTOM, '--yes']
    const run = await runCli(args, bench.env)
    expect([run.code, run.stderr]).toStrictEqual([0, ''])
    expect(typesOf(run)).toStrictEqual(expect.arrayContaining(['ask.requested', 'ask.answered']))
    expect(typesOf(run).at(-1)).toBe('session.completed')
    expect(readFileSync(helloIn(bench.repo), 'utf8')).toContain('export function hello()')
    await bench.daemon.stop()
  })
})

describe('bytebureau run on an ACP agent that waits for a permission', () => {
  it('ends with exit 3 and a ready session when the run is interrupted while the agent waits for a permission', async () => {
    expect.hasAssertions()
    const waiting = await waitingOnPermission()
    const interrupted = await runCli(['sessions', 'interrupt', waiting.sessionId], waiting.env)
    const run = await waiting.run
    const shown = await untilStatus({ env: waiting.env, id: waiting.sessionId }, 'ready')
    const left = await runCli(['ask', 'ls', '--json'], waiting.env)
    // The ask is cancelled first; the agent, told so, ends its turn as interrupted
    expect([interrupted.code, run.code, fromTheAsk(run)]).toStrictEqual([
      0,
      3,
      [
        'ask.requested',
        'session.waiting',
        'ask.cancelled',
        'tool.failed',
        'message.assistant.completed',
        'turn.interrupted',
        'session.ready',
      ],
    ])
    expect(shown.stdout).toMatch(/^status\s+ready$/mu)
    expect([listedUnder(left.stdout, 'asks'), existsSync(helloIn(waiting.repo))]).toStrictEqual([
      [],
      false,
    ])
    await waiting.daemon.stop()
  })

  it('ends with exit 3 and a stopped session, with no ask left, when Ctrl-C stops the run while the agent waits', async () => {
    expect.hasAssertions()
    const bench = await onTheFake()
    const args = ['run', PROMPT, '--project', bench.repo, ...ON_CUSTOM]
    const run = await runCli(args, bench.env, { signal: 'SIGINT', afterStdout: ASKED })
    const id = await sessionIdIn(bench.home, [])
    const shown = await runCli(['sessions', 'show', id], bench.env)
    const left = await runCli(['ask', 'ls', '--json'], bench.env)
    expect([run.code, fromTheAsk(run), listedUnder(left.stdout, 'asks')]).toStrictEqual([
      3,
      ['ask.requested', 'session.waiting', 'turn.interrupted', 'ask.cancelled', 'session.stopped'],
      [],
    ])
    expect(shown.stdout).toMatch(/^status\s+stopped$/mu)
    await bench.daemon.stop()
  })
})

describe('bytebureau run on an ACP agent that cannot be started', () => {
  it('refuses a custom preset without a command, and a vendor agent that is not installed, with exit 4 and the hint', async () => {
    expect.hasAssertions()
    const { repo, home, env, daemon } = await benchWithDaemon()
    const withoutCommand = await runCli(
      ['run', 'x', '--project', repo, '--provider', 'acp:custom'],
      env,
    )
    // Trusted, so the override is run and not the codex-acp the machine may have installed
    configureHome(home, { trust: { commands: ['bun', 'codex-acp-definitely-missing'] } })
    writeConfig(repo, { providers: { 'acp:codex': { command: 'codex-acp-definitely-missing' } } })
    const missing = await runCli(['run', 'x', '--project', repo, '--provider', 'acp:codex'], env)
    expect([withoutCommand.code, withoutCommand.stderr]).toStrictEqual([
      4,
      `${path.join(repo, 'bytebureau.json')}: providers["acp:custom"].command is not configured (config_invalid)\n`,
    ])
    expect([missing.code, missing.stderr]).toStrictEqual([
      4,
      `codex-acp-definitely-missing is not installed; ${CODEX_HINTS} (provider_crash)\n`,
    ])
    await daemon.stop()
  })
})

describe('bytebureau run on an ACP agent that a cloned project names', () => {
  it('refuses a command the user configuration does not trust with exit 4, the key and the way to trust it', async () => {
    expect.hasAssertions()
    const bench = await onTheFake()
    configureHome(bench.home, { trust: {} })
    const refused = await runCli(
      ['run', 'x', '--project', bench.repo, '--provider', 'acp:custom'],
      bench.env,
    )
    expect([refused.code, refused.stderr]).toStrictEqual([
      4,
      `${path.join(bench.repo, 'bytebureau.json')}: providers["acp:custom"].command is not configured; the project names a command the user configuration does not trust: add it to trust.commands, or the project to trust.projects, in ${path.join(bench.home, 'config.json')} (config_invalid)\n`,
    ])
    expect(existsSync(helloIn(bench.repo))).toBe(false)
    await bench.daemon.stop()
  })
})

describe('bytebureau run on an ACP agent under an API-key profile', () => {
  it('hands an API-key profile of an ACP provider to the agent as the preset names it', async () => {
    expect.hasAssertions()
    const bench = await benchOn({
      'acp:codex': { ...fakeAcpPreset(), apiKeyEnv: 'FAKE_ACP_API_KEY' },
    })
    const add = ['profiles', 'add', 'acp:codex', 'key', '--api-key']
    const added = await runCliWithStdin(add, bench.env, `${CANARY}\n`)
    const args = ['run', PROMPT, '--project', bench.repo, '--provider', 'acp:codex']
    const run = await runCli([...args, '--profile', 'acp:codex/key', '--json', '--yes'], bench.env)
    expect([added.code, run.code]).toStrictEqual([0, 0])
    expect(run.stdout).toContain('hello; api key present')
    expect([added.stdout, added.stderr, run.stdout, run.stderr].join('\n')).not.toContain(CANARY)
    await bench.daemon.stop()
  })
})
