import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProfileRef } from '@bytebureau/plugin-api'
import { describe, expect, it, vi } from 'vitest'
import { authStatusOf } from './auth.js'
import { fakeQuery, type FakeQuery, type FakeScript } from './testing/fake-query.js'
import { loginProfile, recordingLogger } from './testing/requests.js'

const checked = async (
  script: FakeScript,
  profile: ProfileRef = loginProfile,
): Promise<{
  readonly status: Awaited<ReturnType<typeof authStatusOf>>
  readonly fake: FakeQuery
}> => {
  const fake = fakeQuery(script)
  const deps = { query: fake.query, logger: recordingLogger().logger }
  const status = await authStatusOf(deps, profile, '/opt/bin/claude')
  return { status, fake }
}

// The account the CLI reports when nobody is logged in, as the probe of Task 6 saw it
const NOBODY = { tokenSource: 'none', apiProvider: 'firstParty' } as const

describe(authStatusOf, () => {
  it('reports a login the CLI knows as logged in, with its account, from a probe that says nothing and is closed', async () => {
    expect.hasAssertions()
    const { status, fake } = await checked({
      account: { email: 'dev@example.com', subscriptionType: 'Claude Team' },
    })
    expect(status).toStrictEqual({ state: 'loggedIn', account: 'dev@example.com' })
    expect(fake.options[0]).toMatchObject({
      cwd: tmpdir(),
      settingSources: [],
      permissionMode: 'default',
      maxTurns: 1,
      pathToClaudeCodeExecutable: '/opt/bin/claude',
    })
    expect(fake.prompts).toStrictEqual([])
    expect(fake.calls.close).toBe(1)
  })

  it('reports a CLI that knows no account as logged out, with the command to log in', async () => {
    expect.hasAssertions()
    const { status } = await checked({ account: NOBODY })
    expect(status).toStrictEqual({ state: 'loggedOut', hint: 'claude /login' })
  })

  it('names the directory of a login profile in the command, and points the probe at it', async () => {
    expect.hasAssertions()
    const configDir = mkdtempSync(path.join(tmpdir(), 'bb-claude-profile-'))
    try {
      const { status, fake } = await checked(
        { account: NOBODY },
        { id: 'claude/work', providerId: 'claude', kind: 'login', configDir },
      )
      expect(status).toStrictEqual({
        state: 'loggedOut',
        hint: `CLAUDE_CONFIG_DIR=${configDir} claude /login`,
      })
      expect(fake.options[0]).toHaveProperty('env.CLAUDE_CONFIG_DIR', configDir)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})

describe('the login check of a profile that cannot be probed', () => {
  it('reports a profile whose directory is gone as logged out, without asking the CLI', async () => {
    expect.hasAssertions()
    const gone = {
      id: 'claude/gone',
      providerId: 'claude',
      kind: 'login',
      configDir: '/nonexistent/bb/claude/gone',
    } as const
    const { status, fake } = await checked({}, gone)
    expect(status).toStrictEqual({
      state: 'loggedOut',
      hint: 'CLAUDE_CONFIG_DIR=/nonexistent/bb/claude/gone claude /login',
    })
    expect(fake.options).toStrictEqual([])
  })

  it('leaves an API-key profile to a session to check, as the probe cannot carry the key', async () => {
    expect.hasAssertions()
    const { status, fake } = await checked(
      {},
      { id: 'claude/ci', providerId: 'claude', kind: 'api_key' },
    )
    expect(status).toStrictEqual({
      state: 'unknown',
      hint: 'run a session to check an API-key profile',
    })
    expect(fake.options).toStrictEqual([])
  })
})

describe('a login check that fails', () => {
  it('tells a login error as logged out, an expired login as expired, and anything else as unknown with its reason', async () => {
    expect.hasAssertions()
    const login = await checked({ initFailure: new Error('Not logged in · Please run /login') })
    expect(login.status).toStrictEqual({ state: 'loggedOut', hint: 'claude /login' })
    const expired = await checked({ initFailure: new Error('OAuth token has expired') })
    expect(expired.status).toStrictEqual({ state: 'expired', hint: 'claude /login' })
    const missing = await checked({ initFailure: new Error('spawn /opt/bin/claude ENOENT') })
    expect(missing.status).toStrictEqual({ state: 'unknown', hint: 'spawn /opt/bin/claude ENOENT' })
    expect(missing.fake.calls.close).toBe(1)
  })

  it('tells a Claude Code that cannot even be started as unknown, with the reason', async () => {
    expect.hasAssertions()
    const reason = 'Native CLI binary for darwin-arm64 not found.'
    const { status, fake } = await checked({ throws: new Error(reason) })
    expect(status).toStrictEqual({ state: 'unknown', hint: reason })
    expect(fake.options).toHaveLength(1)
  })

  it('gives up on a CLI that does not answer within 20 s', async () => {
    expect.hasAssertions()
    vi.useFakeTimers()
    try {
      const pending = checked({ hangs: true })
      await vi.advanceTimersByTimeAsync(20_000)
      const { status, fake } = await pending
      expect(status).toStrictEqual({
        state: 'unknown',
        hint: 'the Claude login check did not answer within 20 s',
      })
      expect(fake.options[0]).toHaveProperty('abortController.signal.aborted', true)
    } finally {
      vi.useRealTimers()
    }
  })
})

const ALLOWED = /^(?:PATH|HOME|USER|LANG|TMPDIR|TERM|SSH_AUTH_SOCK|TRACEPARENT|LC_\w+)$/u

// The names of the variables the probe was given that the allowlist does not hold
const unexpectedNames = (fake: FakeQuery): readonly string[] => {
  const [options] = fake.options
  const env = options === undefined || options.env === undefined ? {} : options.env
  return Object.keys(env).filter((name) => !ALLOWED.test(name))
}

describe('the environment of the login check', () => {
  it("passes the variables of the kernel's allowlist, the user name among them, never a key or anything else", async () => {
    expect.hasAssertions()
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-of-the-daemon')
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'sdk-ts')
    vi.stubEnv('USER', 'dev')
    vi.stubEnv('TRACEPARENT', '00-a-b-01')
    try {
      const { fake } = await checked({ account: NOBODY })
      expect(fake.options[0]).toMatchObject({ env: { USER: 'dev', TRACEPARENT: '00-a-b-01' } })
      expect(unexpectedNames(fake)).toStrictEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

const SPACED = {
  id: 'claude/spaced',
  providerId: 'claude',
  kind: 'login',
  configDir: "/nonexistent/My Profiles/dev's claude",
} as const

describe('the command that logs a profile in', () => {
  it('quotes a directory a shell would split, so the command can be pasted as it is', async () => {
    expect.hasAssertions()
    const { status } = await checked({}, SPACED)
    expect(status).toStrictEqual({
      state: 'loggedOut',
      hint: String.raw`CLAUDE_CONFIG_DIR='/nonexistent/My Profiles/dev'\''s claude' claude /login`,
    })
  })
})
