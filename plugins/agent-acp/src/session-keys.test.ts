import { describe, expect, it } from 'vitest'
import { CANARY_KEY } from './testing/requests.js'
import { harness } from './testing/session-harness.js'
import { customOf, prompted, sessionOf, workspaceOf } from './testing/sessions.js'

describe('the key of an ACP session', () => {
  it('is redacted from an error the agent answers a prompt with', async () => {
    expect.hasAssertions()
    const run = harness()
    const providerConfig = customOf('refuse-prompt', { apiKeyEnv: 'FAKE_ACP_API_KEY' })
    const env = { PATH: '/usr/bin:/bin', FAKE_ACP_API_KEY: CANARY_KEY }
    const session = await sessionOf(
      { workspace: { path: workspaceOf() }, providerConfig, env },
      run,
    )
    const told = JSON.stringify([await prompted(session, 'Create src/hello.ts'), run.logged])
    expect(told).toContain('Internal error: the model is overloaded for [redacted]')
    expect(told).not.toContain(CANARY_KEY)
  })

  it('keeps the key, and any variable named as a key or a token, out of the terminals of the agent', async () => {
    expect.hasAssertions()
    const providerConfig = customOf('terminal', { apiKeyEnv: 'FAKE_ACP_API_KEY' })
    const env = { PATH: '/usr/bin:/bin', FAKE_ACP_API_KEY: CANARY_KEY, GITHUB_TOKEN: 'ghp-canary' }
    const session = await sessionOf({ workspace: { path: workspaceOf() }, providerConfig, env })
    const seen = await prompted(session, 'Run node')
    expect(seen).toContainEqual({
      type: 'message.delta',
      kind: 'text',
      text: 'hello; api key present',
    })
    expect(seen).toContainEqual({ type: 'message.delta', kind: 'text', text: 'terminal said ok' })
    expect(JSON.stringify(seen)).not.toContain(CANARY_KEY)
  })

  it('hands the API key to the agent alone: no event or log line holds it', async () => {
    expect.hasAssertions()
    const run = harness()
    const providerConfig = customOf('crash-mid-turn', { apiKeyEnv: 'FAKE_ACP_API_KEY' })
    const env = { PATH: '/usr/bin:/bin', FAKE_ACP_API_KEY: CANARY_KEY }
    const session = await sessionOf(
      { workspace: { path: workspaceOf() }, providerConfig, env },
      run,
    )
    const told = JSON.stringify([
      await prompted(session, 'Show me the key', 'session.closed'),
      run.logged,
    ])
    expect(told).toContain('hello; api key present')
    expect(told).toContain('the fake agent crashed mid-turn holding [redacted]')
    expect(told).not.toContain(CANARY_KEY)
  })
})
