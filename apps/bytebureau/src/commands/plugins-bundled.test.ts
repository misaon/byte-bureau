import { createBureauClient } from '@bytebureau/client'
import { describe, expect, it } from 'vitest'
import { startDaemonProcess } from '../testing/daemon.js'
import { jsonLines } from '../testing/json-lines.js'
import { runCli } from '../testing/run-cli.js'
import { testHome } from '../testing/temp-repo.js'

// The ACP plugin offers one agent provider per preset
const ACP_PORTS = ['codex', 'gemini', 'opencode', 'pi', 'custom'].map(
  (preset) => `agentProviders:acp:${preset}`,
)

describe('the plugins a daemon bundles', () => {
  it('are listed as loaded: the local worktrees, the fake agent, Claude Code and the ACP agents', async () => {
    expect.hasAssertions()
    const home = testHome()
    const daemon = await startDaemonProcess(home)
    const listed = await runCli(['plugins', 'ls', '--json'], { BYTEBUREAU_HOME: home })
    expect(jsonLines(listed.stdout)).toMatchObject([
      {
        command: 'plugins.ls',
        plugins: [
          { name: 'workspace-local', state: 'loaded', ports: ['workspaceRuntimes:local'] },
          { name: 'agent-fake', state: 'loaded', ports: ['agentProviders:fake'] },
          { name: 'agent-claude', state: 'loaded', ports: ['agentProviders:claude'] },
          { name: 'agent-acp', state: 'loaded', ports: ACP_PORTS },
        ],
      },
    ])
    await daemon.stop()
  })
})

describe('the agent providers a daemon offers', () => {
  it('are the seven of the bundled plugins, each saying whether it takes an API key', async () => {
    expect.hasAssertions()
    const daemon = await startDaemonProcess(testHome())
    const client = createBureauClient({ baseUrl: daemon.url, token: daemon.info.token })
    await expect(client.plugins.providers()).resolves.toStrictEqual([
      { id: 'fake', displayName: 'Fake agent (tests and CI)', supportsApiKey: true },
      { id: 'claude', displayName: 'Claude Code (Agent SDK)', supportsApiKey: true },
      { id: 'acp:codex', displayName: 'Codex (ACP)', supportsApiKey: true },
      { id: 'acp:gemini', displayName: 'Gemini CLI (ACP)', supportsApiKey: true },
      { id: 'acp:opencode', displayName: 'OpenCode (ACP)', supportsApiKey: false },
      { id: 'acp:pi', displayName: 'pi (ACP)', supportsApiKey: false },
      { id: 'acp:custom', displayName: 'Custom agent (ACP)', supportsApiKey: false },
    ])
    await daemon.stop()
  })
})
