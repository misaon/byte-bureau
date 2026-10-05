import type { ChildProcess } from 'node:child_process'
import type { AgentSession, ExecHandle, ProcessSpawner } from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import { sessionRequest } from './testing/requests.js'
import { AcpAgentProvider } from './provider.js'
import {
  goneWithin,
  harness,
  killedAtEnd,
  rest,
  started,
  until,
  type Harness,
} from './testing/session-harness.js'
import { customOf, prompted, sessionOf, workspaceOf } from './testing/sessions.js'

const CUSTOM = 'acp:custom'

describe('the agent an ACP session starts', () => {
  it('runs in the workspace with the environment of the request, the preset and the login directory, in a group of its own with no window', async () => {
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
    const spawnedWith = run.spawned.map(({ options }) => [
      options.cwd,
      options.env,
      options.detached,
      options.windowsHide,
    ])
    expect(spawnedWith).toStrictEqual([[workspace, env, true, true]])
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

// The process port of a harness that holds the start of every terminal until it is released
const holding = (
  run: Harness,
): {
  readonly provider: AcpAgentProvider
  readonly asked: Promise<null>
  readonly release: () => void
  readonly spawned: Promise<ExecHandle>
} => {
  const asked = Promise.withResolvers<null>()
  const gate = Promise.withResolvers<null>()
  const spawned = Promise.withResolvers<ExecHandle>()
  const held: ProcessSpawner = {
    async spawn(spec) {
      asked.resolve(null)
      await gate.promise
      const handle = await run.deps.process.spawn(spec)
      spawned.resolve(handle)
      return handle
    },
  }
  const release = (): void => {
    gate.resolve(null)
  }
  const provider = new AcpAgentProvider('custom', { ...run.deps, process: held })
  return { provider, asked: asked.promise, release, spawned: spawned.promise }
}

// Every agent of the harness dies, as a crash kills it
const crash = (run: Harness): void => {
  for (const { child } of run.spawned) {
    child.kill('SIGKILL')
  }
}

// The children script's agent killed while the start of its terminal is held, and the session ended by the crash
const crashedWithTerminalHeld = async (): Promise<{
  readonly release: () => void
  readonly spawned: Promise<ExecHandle>
  readonly prompting: Promise<void>
}> => {
  const run = harness()
  const { provider, asked, release, spawned } = holding(run)
  const request = { workspace: { path: workspaceOf() }, providerConfig: customOf('children') }
  const session = await started(provider, sessionRequest(request))
  const ending = rest(session)
  const prompting = session.prompt({ text: 'Start some work' })
  await asked
  crash(run)
  await ending
  return { release, spawned, prompting }
}

describe('a terminal of an agent that crashed', () => {
  it('is ended once it has started, when its start was under way at the crash', async () => {
    expect.hasAssertions()
    const { release, spawned, prompting } = await crashedWithTerminalHeld()
    release()
    await prompting
    const { pid } = await spawned
    await expect(goneWithin(pid, 3000)).resolves.toBe(true)
  })
})
