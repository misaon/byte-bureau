import { ProviderConfigError, type PluginContext } from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { claudeAgentPlugin } from './plugin.js'
import { ClaudeAgentProvider } from './provider.js'
import { fakeQuery, type FakeQuery } from './testing/fake-query.js'
import { recordingLogger, sessionRequest, TRUSTED } from './testing/requests.js'

// A provider over a fake query whose claude is installed only where the test says
const providerWith = (
  installed: Readonly<Record<string, string>>,
): { readonly provider: ClaudeAgentProvider; readonly fake: FakeQuery } => {
  const fake = fakeQuery()
  const resolveExecutable = (name: string): string | undefined => installed[name]
  const provider = new ClaudeAgentProvider({
    query: fake.query,
    logger: recordingLogger().logger,
    resolveExecutable,
  })
  return { provider, fake }
}

const executableOf = async (
  installed: Readonly<Record<string, string>>,
  providerConfig: Readonly<Record<string, unknown>>,
): Promise<unknown> => {
  const { provider, fake } = providerWith(installed)
  const session = await provider.createSession(sessionRequest({ providerConfig }))
  await session.close()
  const [options] = fake.options
  return options === undefined ? undefined : options.pathToClaudeCodeExecutable
}

describe(ClaudeAgentProvider, () => {
  it('announces itself as claude, takes the key of a profile in ANTHROPIC_API_KEY, and says what it can do', () => {
    expect.hasAssertions()
    const { provider } = providerWith({})
    expect(provider).toMatchObject({
      id: 'claude',
      displayName: 'Claude Code (Agent SDK)',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    })
    expect(provider.capabilities).toMatchObject({
      resume: true,
      interrupt: true,
      askUser: true,
      permissions: true,
      usage: true,
      rateLimits: true,
    })
    expect(provider.capabilities).toMatchObject({ setEffort: false, attachments: false })
  })

  it('runs the configured claude, else the one on PATH, else the bundled one of the SDK', async () => {
    expect.hasAssertions()
    const installed = { '/opt/claude': '/opt/claude', claude: '/usr/local/bin/claude' }
    await expect(executableOf(installed, { executable: '/opt/claude' })).resolves.toBe(
      '/opt/claude',
    )
    await expect(executableOf(installed, {})).resolves.toBe('/usr/local/bin/claude')
    await expect(executableOf({}, {})).resolves.toBeUndefined()
  })

  it('refuses a session whose providers.claude has a key it does not know, and checks a login', async () => {
    expect.hasAssertions()
    const { provider } = providerWith({})
    const refused = provider.createSession(sessionRequest({ providerConfig: { model: 'x' } }))
    await expect(refused).rejects.toThrow(/^providers\.claude: /u)
    await expect(refused).rejects.toBeInstanceOf(ProviderConfigError)
    await expect(
      provider.authStatus({ id: 'claude/ci', providerId: 'claude', kind: 'api_key' }),
    ).resolves.toMatchObject({ state: 'unknown' })
  })
})

// Only the claude on PATH is installed
const onPath = (name: string): string | undefined =>
  name === 'claude' ? '/usr/local/bin/claude' : undefined

describe('a configured claude that is not found', () => {
  it('is warned of by its name and passed over for the default one', async () => {
    expect.hasAssertions()
    const { logger, entries } = recordingLogger()
    const fake = fakeQuery()
    const provider = new ClaudeAgentProvider({
      query: fake.query,
      logger,
      resolveExecutable: onPath,
    })
    const session = await provider.createSession(
      sessionRequest({ providerConfig: { executable: '~/bin/claude' } }),
    )
    await session.close()
    expect(fake.options[0]).toHaveProperty('pathToClaudeCodeExecutable', '/usr/local/bin/claude')
    expect(entries).toStrictEqual([
      {
        level: 'warn',
        message: 'the claude of providers.claude.executable is not found; the default one runs',
        properties: { executable: '~/bin/claude' },
      },
    ])
  })
})

describe('a project the user does not trust', () => {
  it('is warned of, as Claude Code then loads the settings of the user alone', async () => {
    expect.hasAssertions()
    const { logger, entries } = recordingLogger()
    const fake = fakeQuery()
    const provider = new ClaudeAgentProvider({
      query: fake.query,
      logger,
      resolveExecutable: onPath,
    })
    const untrusted = { ...TRUSTED, project: false }
    const session = await provider.createSession(sessionRequest({ trust: untrusted }))
    await session.close()
    expect(fake.options[0]).toHaveProperty('settingSources', ['user'])
    expect(entries.map((entry) => [entry.level, entry.message, entry.properties])).toStrictEqual([
      [
        'warn',
        expect.stringMatching(/^Claude Code loads the user's settings alone, .*trust\.projects/u),
        { sessionId: sessionRequest().sessionId },
      ],
    ])
  })
})

const unused = (): never => {
  throw new Error('the Claude plugin does not use this part of the plugin context')
}

const context: PluginContext = {
  config: undefined,
  project: null,
  logger: recordingLogger().logger,
  events: { publish: unused, subscribe: unused },
  secrets: { get: unused, set: unused, delete: unused },
  kv: { get: unused, set: unused, delete: unused },
  process: { spawn: unused },
  http: fetch,
  signal: new AbortController().signal,
}

describe('the agent-claude plugin', () => {
  it('declares in its manifest what its package declares, and registers the claude provider', async () => {
    expect.hasAssertions()
    expect(claudeAgentPlugin.manifest).toMatchObject(pkg.bytebureau)
    const registration = await claudeAgentPlugin.setup(context)
    expect(registration.agentProviders).toMatchObject([{ id: 'claude' }])
  })
})
