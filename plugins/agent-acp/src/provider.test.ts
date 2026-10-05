import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PluginContext, ProfileRef } from '@bytebureau/plugin-api'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import pkg from '../package.json' with { type: 'json' }
import { acpAgentPlugin } from './plugin.js'
import { AcpAgentProvider } from './provider.js'
import { CANARY_KEY, recordingLogger, sessionRequest, tempDir } from './testing/requests.js'
import { fakeAgentCommand } from './testing/run-fake.js'
import { harness, started, until } from './testing/session-harness.js'

const CODEX_MISSING =
  'codex-acp is not installed; install it with: npm install -g @agentclientprotocol/codex-acp; then log in with: codex login'
const LOGIN: ProfileRef = { id: 'acp:codex/work', providerId: 'acp:codex', kind: 'login' }

// A PATH of one directory that holds the commands named, as executables that are never run
const pathWith = (...commands: readonly string[]): string => {
  const dir = tempDir('bb-acp-path-')
  for (const command of commands) {
    writeFileSync(path.join(dir, command), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  }
  return dir
}

// The daemon's PATH, for the rest of the test, holds the commands named and nothing else
const onPath = (...commands: readonly string[]): void => {
  vi.stubEnv('PATH', pathWith(...commands))
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
}

const workspaceOf = (): string => {
  const workspace = path.join(tempDir('bb-acp-ws-'), 'ws')
  mkdirSync(workspace)
  return workspace
}

describe(AcpAgentProvider, () => {
  it('announces each preset as acp:<preset>, with the key variable the agent takes, if any', () => {
    expect.hasAssertions()
    const { deps } = harness()
    const presets = ['codex', 'gemini', 'opencode', 'pi', 'custom'] as const
    const providers = presets.map((preset) => new AcpAgentProvider(preset, deps))
    expect(
      providers.map(({ id, displayName, apiKeyEnv }) => [id, displayName, apiKeyEnv]),
    ).toStrictEqual([
      ['acp:codex', 'Codex (ACP)', 'OPENAI_API_KEY'],
      ['acp:gemini', 'Gemini CLI (ACP)', 'GEMINI_API_KEY'],
      ['acp:opencode', 'OpenCode (ACP)', undefined],
      ['acp:pi', 'pi (ACP)', undefined],
      ['acp:custom', 'Custom agent (ACP)', undefined],
    ])
  })

  it('says what an ACP agent can do: resume, interrupt, permissions and thinking, nothing more', () => {
    expect.hasAssertions()
    expect(new AcpAgentProvider('gemini', harness().deps).capabilities).toStrictEqual({
      resume: true,
      interrupt: true,
      askUser: false,
      permissions: true,
      structuredOutput: false,
      usage: false,
      rateLimits: false,
      contextUsage: false,
      thinking: true,
      setModel: false,
      setEffort: false,
      attachments: false,
    })
  })
})

describe('an ACP agent that cannot be started', () => {
  it('refuses the session of an agent that is not installed with the install and login hints', async () => {
    expect.hasAssertions()
    const { deps } = harness()
    const request = sessionRequest({
      workspace: { path: workspaceOf() },
      env: { PATH: pathWith() },
    })
    await expect(new AcpAgentProvider('codex', deps).createSession(request)).rejects.toThrow(
      CODEX_MISSING,
    )
    const custom = { command: 'bb-no-such-agent' }
    const missing = sessionRequest({ workspace: { path: workspaceOf() }, providerConfig: custom })
    await expect(new AcpAgentProvider('custom', deps).createSession(missing)).rejects.toThrow(
      /^bb-no-such-agent is not installed; install it, or point providers\["acp:custom"\]\.command at the agent to run; then log in with: /u,
    )
  })

  it('refuses a custom session without a command, and starts nothing', async () => {
    expect.hasAssertions()
    const { deps, spawned } = harness()
    const request = sessionRequest({ workspace: { path: workspaceOf() } })
    await expect(new AcpAgentProvider('custom', deps).createSession(request)).rejects.toThrow(
      'providers["acp:custom"].command is not configured',
    )
    expect(spawned).toStrictEqual([])
  })
})

describe('the login status of an ACP agent', () => {
  it('is unknown with the install hint while the command is not on PATH, and with the login hint once it is', async () => {
    expect.hasAssertions()
    const { deps, spawned } = harness()
    const provider = new AcpAgentProvider('codex', deps)
    onPath()
    await expect(provider.authStatus(LOGIN)).resolves.toStrictEqual({
      state: 'unknown',
      hint: 'install it with: npm install -g @agentclientprotocol/codex-acp',
    })
    onPath('codex-acp')
    await expect(provider.authStatus(LOGIN)).resolves.toStrictEqual({
      state: 'unknown',
      hint: 'codex login',
    })
    expect(spawned).toStrictEqual([])
  })

  it('is logged out for a login profile whose directory is gone, and asks nothing of a custom command', async () => {
    expect.hasAssertions()
    const { deps, spawned } = harness()
    onPath('opencode')
    const gone = {
      ...LOGIN,
      providerId: 'acp:opencode',
      configDir: path.join(tempDir('bb-acp-p-'), 'gone'),
    }
    await expect(new AcpAgentProvider('opencode', deps).authStatus(gone)).resolves.toStrictEqual({
      state: 'loggedOut',
      hint: 'opencode auth login',
    })
    const apiKey: ProfileRef = { id: 'acp:custom/ci', providerId: 'acp:custom', kind: 'api_key' }
    await expect(new AcpAgentProvider('custom', deps).authStatus(apiKey)).resolves.toStrictEqual({
      state: 'unknown',
      hint: 'the login command of that agent',
    })
    expect(spawned).toStrictEqual([])
  })
})

describe('the key of an API-key profile', () => {
  it('travels in the variable a preset override names, and nowhere else', async () => {
    expect.hasAssertions()
    const { deps, spawned } = harness()
    const codex = { ...fakeAgentCommand('hello'), apiKeyEnv: 'FAKE_ACP_API_KEY' }
    const env = { PATH: '/usr/bin:/bin', OPENAI_API_KEY: CANARY_KEY }
    const request = sessionRequest({
      workspace: { path: workspaceOf() },
      providerConfig: codex,
      env,
    })
    const session = await started(new AcpAgentProvider('codex', deps), request)
    const reading = until(session, 'turn.completed', { selected: ['deny'] })
    await session.prompt({ text: 'Is the key there?' })
    await expect(reading).resolves.toContainEqual({
      type: 'message.delta',
      kind: 'text',
      text: 'hello; api key present',
    })
    expect(spawned.map(({ options }) => options.env)).toStrictEqual([
      { PATH: '/usr/bin:/bin', FAKE_ACP_API_KEY: CANARY_KEY, BYTEBUREAU_FAKE_ACP_SCRIPT: 'hello' },
    ])
  })
})

const unused = (): never => {
  throw new Error('the ACP plugin does not use this part of the plugin context')
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

describe('the agent-acp plugin', () => {
  it('declares in its manifest what its package declares, and registers a provider per preset', async () => {
    expect.hasAssertions()
    expect(acpAgentPlugin.manifest).toMatchObject({ ...pkg.bytebureau, displayName: 'ACP agents' })
    const registration = await acpAgentPlugin.setup(context)
    expect(registration.agentProviders).toMatchObject([
      { id: 'acp:codex' },
      { id: 'acp:gemini' },
      { id: 'acp:opencode' },
      { id: 'acp:pi' },
      { id: 'acp:custom' },
    ])
  })
})
