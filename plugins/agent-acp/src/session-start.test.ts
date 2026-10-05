import path from 'node:path'
import type { AgentSession, CreateSessionRequest } from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import type { PresetId } from './presets.js'
import { AcpAgentProvider } from './provider.js'
import { CANARY_KEY, sessionRequest, tempDir } from './testing/requests.js'
import { fakeAgentCommand } from './testing/run-fake.js'
import { harness, started, type Harness } from './testing/session-harness.js'
import { workspaceOf } from './testing/sessions.js'

const node = process.execPath

// The start of a session whose preset runs what the entry says, with every agent it starts recorded
const starting = (
  preset: PresetId,
  entry: Readonly<Record<string, unknown>>,
  request: Partial<CreateSessionRequest> = {},
): { readonly session: Promise<AgentSession>; readonly run: Harness } => {
  const run = harness()
  const provider = new AcpAgentProvider(preset, run.deps)
  const workspace = { path: workspaceOf() }
  return {
    session: started(provider, sessionRequest({ workspace, providerConfig: entry, ...request })),
    run,
  }
}

describe('an ACP agent that does not open a session', () => {
  it('is refused with how it died and its last word, when it dies before it answers', async () => {
    expect.hasAssertions()
    const script = String.raw`process.stderr.write('not logged in\n', () => process.exit(3))`
    const { session } = starting('custom', { command: node, args: ['-e', script] })
    await expect(session).rejects.toThrow(/^the agent exited with code 3: not logged in$/u)
  })

  it('redacts a key that the cut of a long last word runs through', async () => {
    expect.hasAssertions()
    const script = String.raw`process.stderr.write('x'.repeat(1995) + process.env.FAKE_ACP_API_KEY + 'tail', () => process.exit(3))`
    const entry = { command: node, args: ['-e', script], apiKeyEnv: 'FAKE_ACP_API_KEY' }
    const env = { PATH: '/usr/bin:/bin', FAKE_ACP_API_KEY: CANARY_KEY }
    const { session } = starting('custom', entry, { env })
    await expect(session).rejects.toThrow(/^the agent exited with code 3: x{1995}\[redacted\]$/u)
  })

  it('keeps a last word that never ends its line to its first 2000 characters', async () => {
    expect.hasAssertions()
    const script = String.raw`process.stderr.write('x'.repeat(100000), () => process.exit(3))`
    const { session } = starting('custom', { command: node, args: ['-e', script] })
    await expect(session).rejects.toThrow(/^the agent exited with code 3: x{2000}$/u)
  })

  it('is refused with the login to perform, when it asks for one, the key it echoes redacted', async () => {
    expect.hasAssertions()
    const codex = { ...fakeAgentCommand('auth-required'), apiKeyEnv: 'FAKE_ACP_API_KEY' }
    const env = { PATH: '/usr/bin:/bin', OPENAI_API_KEY: CANARY_KEY }
    const { session, run } = starting('codex', codex, { env })
    await expect(session).rejects.toThrow(
      /^Authentication required: no login for \[redacted\]; log in with: codex login$/u,
    )
    expect(run.spawned.map(({ child }) => child.signalCode)).toStrictEqual(['SIGINT'])
  })

  it('is refused and ended when it speaks another version of ACP', async () => {
    expect.hasAssertions()
    const { session, run } = starting('custom', fakeAgentCommand('protocol-v2'))
    await expect(session).rejects.toThrow('the agent speaks ACP v2; ByteBureau speaks ACP v1')
    expect(run.spawned.map(({ child }) => child.signalCode)).toStrictEqual(['SIGINT'])
  })
})

describe('a start that cannot go on', () => {
  it('kills the agent of a start the kernel gives up on', async () => {
    expect.hasAssertions()
    const controller = new AbortController()
    const silent = { command: node, args: ['-e', 'setInterval(() => {}, 1000)'] }
    const { session } = starting('custom', silent, { signal: controller.signal })
    controller.abort()
    await expect(session).rejects.toThrow('the agent was killed by SIGKILL')
  })

  it('refuses a workspace that is not there, and starts nothing', async () => {
    expect.hasAssertions()
    const missing = path.join(tempDir('bb-acp-start-'), 'gone')
    const { session, run } = starting('custom', fakeAgentCommand('hello'), {
      workspace: { path: missing },
    })
    await expect(session).rejects.toThrow(`the workspace ${missing} does not exist`)
    expect(run.spawned).toStrictEqual([])
  })
})
