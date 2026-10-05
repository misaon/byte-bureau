import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { startDaemonProcess } from '../testing/daemon.js'
import { jsonLines } from '../testing/json-lines.js'
import { runCli, runCliWithStdin } from '../testing/run-cli.js'
import type { Bench, Env } from '../testing/session-bench.js'
import { ON_FAKE, PROMPT, workbench } from '../testing/workbench.js'

const CANARY = 'sk-ant-canary-7f3a9c2e'

// A daemon that logs all it can, so a key in any line of it would show
async function debugBench(): Promise<Bench> {
  const { repo, home } = workbench()
  const daemon = await startDaemonProcess(home, ['--port', '0', '--debug'])
  return { repo, home, env: { BYTEBUREAU_HOME: home }, daemon }
}

// What the listings of the profiles and of their status tell, as JSON
async function listingsOf(env: Env): Promise<string> {
  const listed = await runCli(['profiles', 'ls', '--json'], env)
  const checked = await runCli(['profiles', 'status', '--json'], env)
  return [listed.stdout, listed.stderr, checked.stdout, checked.stderr].join('\n')
}

// The warning of the fake agent that it was given the variable of the key, which it tells without the value
const tellsKey = (event: Record<string, unknown>): boolean =>
  event['type'] === 'session.warning' && JSON.stringify(event).includes('api key: present')

interface Said {
  readonly codes: readonly number[]
  readonly toldKey: boolean
  // Everything the commands printed
  readonly text: string
}

// The key added on stdin, a run under its profile, and the listings after it
async function addedAndRun({ env, repo }: Bench): Promise<Said> {
  const add = ['profiles', 'add', 'fake', 'key', '--api-key']
  const added = await runCliWithStdin(add, env, `${CANARY}\n`)
  const args = ['run', PROMPT, '--project', repo, ...ON_FAKE, '--profile', 'fake/key']
  const run = await runCli([...args, '--json', '--yes'], env)
  const listings = await listingsOf(env)
  return {
    codes: [added.code, run.code],
    toldKey: jsonLines(run.stdout).some((event) => tellsKey(event)),
    text: [added.stdout, added.stderr, run.stdout, run.stderr, listings].join('\n'),
  }
}

// Every file under the directory, however deep
const filesIn = (directory: string): string[] =>
  readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))

const secretsOf = (home: string): string => path.join(home, 'secrets.json')

// What the daemon logged, and every file of the home but its secrets and of the repository with its worktree: the store and its journal among them
function leftBehind({ home, repo, daemon }: Bench): string {
  const files = [...filesIn(home).filter((file) => file !== secretsOf(home)), ...filesIn(repo)]
  const contents = files.map((file) => readFileSync(file).toString('latin1'))
  return [daemon.stdout(), daemon.stderr(), ...contents].join('\n')
}

describe('an API key added through the CLI', () => {
  it('reaches the agent and nowhere else: not the events, the log, the store, the listings or the status', async () => {
    expect.hasAssertions()
    const bench = await debugBench()
    const said = await addedAndRun(bench)
    expect([said.codes, said.toldKey]).toStrictEqual([[0, 0], true])
    await bench.daemon.stop()
    expect(`${said.text}\n${leftBehind(bench)}`).not.toContain(CANARY)
    expect(readFileSync(secretsOf(bench.home), 'utf8')).toContain(CANARY)
  })
})
