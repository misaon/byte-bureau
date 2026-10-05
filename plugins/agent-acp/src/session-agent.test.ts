import { describe, expect, it } from 'vitest'
import { sessionRequest } from './testing/requests.js'
import { harness, until } from './testing/session-harness.js'
import { customOf, prompted, sessionOf, workspaceOf } from './testing/sessions.js'

describe('the agent an ACP session starts', () => {
  it('runs in the workspace with the environment of the request, the preset and the login directory', async () => {
    expect.hasAssertions()
    const workspace = workspaceOf()
    const run = harness()
    const profile = {
      id: 'acp:custom/work',
      providerId: 'acp:custom',
      kind: 'login',
      configDir: '/h/p',
    } as const
    const providerConfig = customOf('hello', { configDirEnv: 'FAKE_ACP_HOME' })
    await sessionOf({ workspace: { path: workspace }, providerConfig, profile }, run)
    const env = {
      ...sessionRequest().env,
      BYTEBUREAU_FAKE_ACP_SCRIPT: 'hello',
      FAKE_ACP_HOME: '/h/p',
    }
    expect(run.spawned.map(({ options }) => [options.cwd, options.env])).toStrictEqual([
      [workspace, env],
    ])
  })

  it('loads the session a resume names when the agent can, and starts a new one for a resume of another provider', async () => {
    expect.hasAssertions()
    const base = { workspace: { path: workspaceOf() }, providerConfig: customOf('hello') }
    const resume = { providerId: 'acp:custom', ref: 'fake-acp-earlier' }
    const loaded = await sessionOf({ ...base, resume })
    expect(loaded.externalRef).toStrictEqual(resume)
    const [first] = await prompted(loaded, 'Go on')
    expect(first).toStrictEqual({ type: 'turn.started' })
    const fresh = await sessionOf({
      ...base,
      resume: { providerId: 'claude', ref: 'session-0001' },
    })
    expect(fresh.externalRef).toStrictEqual({ providerId: 'acp:custom', ref: 'fake-acp-1' })
  })
})

// The warning of a resume the agent could not load, for the reason it gives
const notLoaded = (why: string): unknown => ({
  type: 'session.warning',
  kind: 'resume',
  message: `the agent could not load session fake-acp-earlier (${why}); a new session was started`,
})

describe('a session to resume that the agent cannot load', () => {
  it('starts a new session, and says so, when the agent answers the load with an error', async () => {
    expect.hasAssertions()
    const resume = { providerId: 'acp:custom', ref: 'fake-acp-earlier' }
    const providerConfig = customOf('load-fails')
    const session = await sessionOf({ workspace: { path: workspaceOf() }, providerConfig, resume })
    expect(session.externalRef).toStrictEqual({ providerId: 'acp:custom', ref: 'fake-acp-1' })
    await expect(until(session, 'session.warning')).resolves.toStrictEqual([
      notLoaded('Resource not found: fake-acp-earlier'),
    ])
  })

  it('starts a new session, and says so, when the agent does not load sessions', async () => {
    expect.hasAssertions()
    const resume = { providerId: 'acp:custom', ref: 'fake-acp-earlier' }
    const providerConfig = customOf('no-load')
    const session = await sessionOf({ workspace: { path: workspaceOf() }, providerConfig, resume })
    expect(session.externalRef).toStrictEqual({ providerId: 'acp:custom', ref: 'fake-acp-1' })
    await expect(until(session, 'session.warning')).resolves.toStrictEqual([
      notLoaded('it does not load sessions'),
    ])
  })
})
