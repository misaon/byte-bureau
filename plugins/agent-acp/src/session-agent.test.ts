import type { ChildProcess } from 'node:child_process'
import type { AgentSession } from '@bytebureau/plugin-api'
import { describe, expect, it, onTestFinished } from 'vitest'
import { sessionRequest } from './testing/requests.js'
import { goneWithin, harness, until } from './testing/session-harness.js'
import { customOf, prompted, sessionOf, workspaceOf } from './testing/sessions.js'

const CUSTOM = 'acp:custom'

describe('the agent an ACP session starts', () => {
  it('runs in the workspace with the environment of the request, the preset and the login directory', async () => {
    expect.hasAssertions()
    const workspace = workspaceOf()
    const run = harness()
    const profile = {
      id: 'acp:custom/work',
      providerId: CUSTOM,
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
    const resume = { providerId: CUSTOM, ref: 'fake-acp-earlier' }
    const loaded = await sessionOf({ ...base, resume })
    expect(loaded.externalRef).toStrictEqual(resume)
    const [first] = await prompted(loaded, 'Go on')
    expect(first).toStrictEqual({ type: 'turn.started' })
    const fresh = await sessionOf({
      ...base,
      resume: { providerId: 'claude', ref: 'session-0001' },
    })
    expect(fresh.externalRef).toStrictEqual({ providerId: CUSTOM, ref: 'fake-acp-1' })
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
    const resume = { providerId: CUSTOM, ref: 'fake-acp-earlier' }
    const providerConfig = customOf('load-fails')
    const session = await sessionOf({ workspace: { path: workspaceOf() }, providerConfig, resume })
    expect(session.externalRef).toStrictEqual({ providerId: CUSTOM, ref: 'fake-acp-1' })
    await expect(until(session, 'session.warning')).resolves.toStrictEqual([
      notLoaded('Resource not found: fake-acp-earlier'),
    ])
  })

  it('starts a new session, and says so, when the agent does not load sessions', async () => {
    expect.hasAssertions()
    const resume = { providerId: CUSTOM, ref: 'fake-acp-earlier' }
    const providerConfig = customOf('no-load')
    const session = await sessionOf({ workspace: { path: workspaceOf() }, providerConfig, resume })
    expect(session.externalRef).toStrictEqual({ providerId: CUSTOM, ref: 'fake-acp-1' })
    await expect(until(session, 'session.warning')).resolves.toStrictEqual([
      notLoaded('it does not load sessions'),
    ])
  })
})

// The pid of the process the children script says it started
const ownChildOf = async (session: AgentSession): Promise<number> => {
  for await (const event of session.events()) {
    if (event.type === 'message.delta' && event.text.startsWith('children ')) {
      return Number(event.text.split(' ')[1])
    }
  }
  return 0
}

// Whether each of the processes is gone within three seconds
const allGone = async (pids: readonly number[]): Promise<boolean[]> => {
  const gone = await Promise.all(
    pids.map(async (pid) => {
      const one = await goneWithin(pid, 3000)
      return one
    }),
  )
  return gone
}

// The pid of the first of the processes, or one nobody has
const firstPid = (children: readonly ChildProcess[]): number => {
  const [first] = children
  return first === undefined || first.pid === undefined ? 0 : first.pid
}

// A process the test learnt of is killed when it ends, should it outlive what the test checks
const killedAtEnd = (pid: number): void => {
  onTestFinished(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone already
    }
  })
}

describe('what an ACP agent starts', () => {
  it('ends with the agent when the session closes, its own processes and its terminals as well', async () => {
    expect.hasAssertions()
    const run = harness()
    const request = { workspace: { path: workspaceOf() }, providerConfig: customOf('children') }
    const session = await sessionOf(request, run)
    const prompting = session.prompt({ text: 'Start some work' })
    const own = await ownChildOf(session)
    killedAtEnd(own)
    await session.close()
    await prompting
    await expect(allGone([own, firstPid(run.terminals)])).resolves.toStrictEqual([true, true])
  })
})
