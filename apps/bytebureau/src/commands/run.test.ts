import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { eventLines, jsonLines, payloadOf } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { tempDir, testHome } from '../testing/temp-repo.js'
import {
  configureEmployeeProvider,
  FAKE,
  NO_DAEMON,
  ON_FAKE,
  PROMPT,
  workbench,
  worktreesOf,
} from '../testing/workbench.js'

// The agent providers of the bundled plugins, as a refusal names them
const AVAILABLE = 'fake, claude, acp:codex, acp:gemini, acp:opencode, acp:pi, acp:custom'

describe('bytebureau run (fake provider, no daemon)', () => {
  it('provisions a worktree, streams NDJSON events with increasing seq, answers the ask with --yes and exits 0', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runCli(['run', PROMPT, '--project', repo, ...FAKE], {
      BYTEBUREAU_HOME: home,
    })
    expect(result.code).toBe(0)
    const events = eventLines(result.stdout)
    const sequence = events.map((line) => line.seq)
    expect(sequence).toStrictEqual([...new Set(sequence)].toSorted((left, right) => left - right))
    expect(events.map((line) => line.type)).toStrictEqual(
      expect.arrayContaining([
        'session.created',
        'workspace.provisioned',
        'turn.started',
        'ask.requested',
        'ask.answered',
        'turn.completed',
        'session.completed',
      ]),
    )
    expect(events.at(-1)).toMatchObject({ type: 'session.completed' })
  })

  it('leaves the file of the agent in the worktree, written as the recommended answer says, and the data in the home', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    await runCli(['run', PROMPT, '--project', repo, ...FAKE], { BYTEBUREAU_HOME: home })
    const [worktree = ''] = readdirSync(worktreesOf(repo))
    const hello = path.join(worktreesOf(repo), worktree, 'src', 'hello.ts')
    expect(readFileSync(hello, 'utf8')).toContain('export function hello()')
    expect(existsSync(path.join(home, 'data', 'bytebureau.db'))).toBe(true)
  })

  it('hands a prompt with CRLF, an emoji and diacritics to the agent unchanged and titles the session by its first line', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const prompt = 'Vytvoř soubor\r\nhello 😀 příliš žluťoučký kůň'
    const result = await runCli(['run', prompt, '--project', repo, ...FAKE], {
      BYTEBUREAU_HOME: home,
    })
    const events = eventLines(result.stdout)
    expect(payloadOf(events, 'message.user')).toStrictEqual({ text: prompt })
    expect(payloadOf(events, 'session.created')).toMatchObject({ title: 'Vytvoř soubor' })
  })
})

describe('bytebureau run when it cannot start', () => {
  it('exits 4 when the provider does not exist and creates nothing', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const env = { BYTEBUREAU_HOME: home }
    const result = await runCli(
      ['run', 'x', '--project', repo, '--provider', 'nope', '--json', NO_DAEMON],
      env,
    )
    expect(result.code).toBe(4)
    expect(existsSync(path.join(repo, '.bytebureau'))).toBe(false)
    expect(jsonLines(result.stderr)).toStrictEqual([
      { level: 'warn', message: `Provider "nope" is not available. Available: ${AVAILABLE}` },
    ])
    const projects = await runCli(['projects', 'ls', '--json', NO_DAEMON], env)
    expect(jsonLines(projects.stdout)).toStrictEqual([{ command: 'projects.ls', projects: [] }])
  })

  it('exits 4 when the provider of the employee of the project is not available', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    configureEmployeeProvider(repo, 'nope')
    const result = await runCli(['run', 'x', '--project', repo, NO_DAEMON], {
      BYTEBUREAU_HOME: home,
    })
    expect(result.code).toBe(4)
    expect(result.stderr).toContain(
      `SessionError: provider "nope" is not available; available: ${AVAILABLE} (provider_missing)`,
    )
    expect(existsSync(worktreesOf(repo))).toBe(false)
  })

  it('exits 4 with a one-line reason, and writes nothing, for a project that is not a repository', async () => {
    expect.hasAssertions()
    const directory = tempDir('bb-plain-')
    const result = await runCli(['run', 'x', '--project', directory, ...ON_FAKE, NO_DAEMON], {
      BYTEBUREAU_HOME: testHome(),
    })
    expect(result.code).toBe(4)
    expect(result.stderr.trim()).toBe(
      `WorkspaceError: ${directory} is not inside a git repository (not_a_repository)`,
    )
    expect(readdirSync(directory)).toStrictEqual([])
  })
})

describe('bytebureau run with an invalid configuration of its project', () => {
  it('is refused with exit 4 and the place of the error named once, in the process of the command', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    writeFileSync(path.join(repo, 'bytebureau.json'), '{ "version": 2 }\n')
    const result = await runCli(['run', 'x', '--project', repo, ...ON_FAKE, NO_DAEMON], {
      BYTEBUREAU_HOME: home,
    })
    expect(result.code).toBe(4)
    expect(result.stderr.trim()).toMatch(
      /^ConfigError: \S+\/bytebureau\.json\/version: Expected 1$/u,
    )
    expect(result.stderr.split('bytebureau.json/version')).toHaveLength(2)
  })
})

describe('bytebureau run on a repository without a commit', () => {
  it('exits 4 with the one-line reason of the worktree that cannot be provisioned', async () => {
    expect.hasAssertions()
    const repo = tempDir('bb-empty-')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    const result = await runCli(['run', 'x', '--project', repo, ...ON_FAKE, NO_DAEMON], {
      BYTEBUREAU_HOME: testHome(),
    })
    expect(result.code).toBe(4)
    const lines = result.stderr.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^WorkspaceError: .*invalid reference: main.* \(git_failed\)$/u)
  })
})

const SLOW = { BYTEBUREAU_FAKE_SCRIPT: 'slow' }

describe('bytebureau run when it is interrupted or nobody answers', () => {
  it('exits 3 and retains the worktree when interrupted mid-turn', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runCli(
      ['run', 'slow task', '--project', repo, ...FAKE],
      { BYTEBUREAU_HOME: home, ...SLOW },
      { signal: 'SIGINT', afterStdout: '"type":"turn.started"' },
    )
    expect(result.code).toBe(3)
    const types = eventLines(result.stdout).map((line) => line.type)
    expect(types).toContain('turn.interrupted')
    expect(types.at(-1)).toBe('session.stopped')
    expect(readdirSync(worktreesOf(repo))).toHaveLength(1)
  })

  it('leaves the session stopped and its worktree on record, ready to be resumed', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const env = { BYTEBUREAU_HOME: home }
    await runCli(
      ['run', 'slow task', '--project', repo, ...FAKE],
      { ...env, ...SLOW },
      { signal: 'SIGINT', afterStdout: '"type":"turn.started"' },
    )
    const listed = await runCli(['workspaces', 'ls', '--json', NO_DAEMON], env)
    expect(jsonLines(listed.stdout)).toMatchObject([
      { command: 'workspaces.ls', workspaces: [{ sessionStatus: 'stopped', exists: true }] },
    ])
  })

  it('waits for an answer, and says so, when the ask cannot be answered without --yes', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runCli(
      ['run', PROMPT, '--project', repo, ...ON_FAKE, '--json', NO_DAEMON],
      { BYTEBUREAU_HOME: home },
      { signal: 'SIGINT', afterStdout: '"type":"session.waiting"' },
    )
    expect(result.code).toBe(3)
    const types = eventLines(result.stdout).map((line) => line.type)
    expect(types).not.toContain('ask.answered')
    const messages = jsonLines(result.stderr).map((line) => line['message'])
    expect(messages).toContain(
      'The employee is waiting for your answer to "Export style" (not answered automatically)',
    )
  })
})

describe('bytebureau run read by a person', () => {
  it('prints plain lines, without decoration, to a pipe', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runCli(
      ['run', PROMPT, '--project', repo, ...ON_FAKE, '--yes', NO_DAEMON],
      { BYTEBUREAU_HOME: home },
    )
    expect(result.code).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toMatch(/^Preparing the workspace on branch bb\//u)
    expect(lines.slice(1, 5)).toStrictEqual([
      '! api key: absent',
      'The employee is working…',
      '⚙ Write src/hello.ts',
      'Created src/hello.ts exporting hello().',
    ])
    expect(lines.at(-1)).toBe('Done — turns: 1, input tokens: 120, output tokens: 40 ($0.0020)')
    expect(result.stdout).not.toContain('│')
  })

  it('speaks Czech when asked to', async () => {
    expect.hasAssertions()
    const { repo, home } = workbench()
    const result = await runCli(
      ['run', PROMPT, '--project', repo, ...ON_FAKE, '--yes', '--lang', 'cs', NO_DAEMON],
      { BYTEBUREAU_HOME: home },
    )
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toMatch(/^Připravuji pracovní prostor na větvi bb\//u)
    expect(lines.at(-1)).toBe('Hotovo — kol: 1, vstupní tokeny: 120, výstupní tokeny: 40 ($0.0020)')
  })
})
