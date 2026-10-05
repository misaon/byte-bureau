import { PassThrough } from 'node:stream'
import type { AgentEvent, AgentSession } from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import type { SpawnFn } from './process.js'
import { AcpAgentProvider } from './provider.js'
import type { FakeScript } from './testing/fake-acp-agent.js'
import { sessionRequest } from './testing/requests.js'
import { endOf, harness, rest, started, until, type Harness } from './testing/session-harness.js'
import { customOf, prompted, sessionOf, TURN_END, workspaceOf } from './testing/sessions.js'

const ALLOW = { selected: ['allow'] }
const FIRST_RESTART = {
  type: 'session.warning',
  kind: 'restart',
  message: 'the agent exited idle; starting it again (1 of 3)',
}

const startedWith = async (
  script: FakeScript,
): Promise<{ readonly session: AgentSession; readonly run: Harness }> => {
  const run = harness()
  const providerConfig = customOf(script)
  const session = await sessionOf({ workspace: { path: workspaceOf() }, providerConfig }, run)
  return { session, run }
}

// One hello turn, its ask answered, and the agent that ran it gone afterwards
const turnThenDeath = async (session: AgentSession, run: Harness): Promise<void> => {
  const reading = until(session, TURN_END, ALLOW)
  await session.prompt({ text: 'Create src/hello.ts' })
  await reading
  const last = run.spawned.at(-1)
  if (last !== undefined) {
    await endOf(last.child)
  }
}

describe('an ACP agent that dies in the middle of a turn', () => {
  it('ends the session with a retryable crash that tells the exit and the last word on stderr', async () => {
    expect.hasAssertions()
    const { session, run } = await startedWith('crash-mid-turn')
    const reading = rest(session)
    await session.prompt({ text: 'Create src/hello.ts' })
    const events = await reading
    const message = 'the agent exited with code 1: the fake agent crashed mid-turn holding no key'
    expect(events.slice(-2)).toStrictEqual([
      { type: 'session.error', kind: 'crash', message, retryable: true },
      { type: 'session.closed' },
    ])
    expect(events.map((event) => event.type)).not.toContain(TURN_END)
    expect(run.logged).toMatchObject([{ level: 'warn', properties: { reason: message } }])
  })
})

describe('an ACP agent that dies while it is idle', () => {
  it('is started again by the next prompt, which tells the restart and runs its turn', async () => {
    expect.hasAssertions()
    const { session, run } = await startedWith('crash-idle')
    await turnThenDeath(session, run)
    const reading = until(session, TURN_END, ALLOW)
    await session.prompt({ text: 'Again' })
    const events = await reading
    expect(events[0]).toStrictEqual(FIRST_RESTART)
    expect(events.slice(1).map((event) => event.type)).toContain(TURN_END)
    expect(run.spawned).toHaveLength(2)
  })

  it('is started again three times at most: its fourth death ends the session with a crash that is not retryable', async () => {
    expect.hasAssertions()
    const { session, run } = await startedWith('crash-idle')
    await turnThenDeath(session, run)
    await turnThenDeath(session, run)
    await turnThenDeath(session, run)
    await turnThenDeath(session, run)
    const message =
      'the agent exited with code 0: the fake agent exited idle; it exited idle 4 times and is not started again'
    await expect(rest(session)).resolves.toStrictEqual([
      { type: 'session.error', kind: 'crash', message, retryable: false },
      { type: 'session.closed' },
    ])
    expect(run.spawned).toHaveLength(4)
  })
})

// One hello turn, its ask answered, and the agent that ran it killed afterwards, its end waited for
const turnThenKilled = async (session: AgentSession, run: Harness): Promise<void> => {
  const reading = until(session, TURN_END, ALLOW)
  await session.prompt({ text: 'Create src/hello.ts' })
  await reading
  const last = run.spawned.at(-1)
  if (last !== undefined) {
    last.child.kill('SIGKILL')
    await endOf(last.child)
  }
}

// The kind and the message of every warning among the events
const warningsOf = (events: readonly AgentEvent[]): readonly (readonly [string, string])[] =>
  events.flatMap((event) =>
    event.type === 'session.warning' ? [[event.kind, event.message] as const] : [],
  )

describe('an ACP agent started again after it died idle', () => {
  it('is asked to load the session of the one before it, and a load it refuses is told', async () => {
    expect.hasAssertions()
    const { session, run } = await startedWith('load-fails')
    await turnThenKilled(session, run)
    const again = until(session, TURN_END, ALLOW)
    await session.prompt({ text: 'Again' })
    const events = await again
    expect(warningsOf(events)).toStrictEqual([
      [FIRST_RESTART.kind, FIRST_RESTART.message],
      ['resume', expect.stringMatching(/^the agent could not load session fake-acp-1 \(/u)],
    ])
    expect(session.externalRef).toStrictEqual({ providerId: 'acp:custom', ref: 'fake-acp-1' })
  })
})

describe('an ACP agent that answers and exits at once', () => {
  it('ends its turn and is started again by the next prompt, its death no crash of the turn it answered', async () => {
    expect.hasAssertions()
    const { session, run } = await startedWith('quick-exit')
    await turnThenDeath(session, run)
    const reading = until(session, TURN_END)
    await session.prompt({ text: 'Again' })
    const events = await reading
    expect(events.map((event) => event.type)).not.toContain('session.error')
    expect(events[0]).toMatchObject({ type: 'session.warning', kind: 'restart' })
  })
})

// Agents whose output reaches the adapter late, so that their death is noticed before what they wrote last is read
const lateOutput =
  (spawn: SpawnFn, delayMs: number): SpawnFn =>
  (command, args, options) => {
    const child = spawn(command, args, options)
    const late = new PassThrough()
    child.stdout.on('data', (chunk: Buffer) => {
      setTimeout(() => {
        late.write(chunk)
      }, delayMs)
    })
    child.stdout.on('end', () => {
      setTimeout(() => {
        late.end()
      }, delayMs)
    })
    Object.defineProperty(child, 'stdout', { value: late })
    return child
  }

const HELLO = 'hello; api key absent'

describe('an ACP agent whose death is noticed before its answer is read', () => {
  it('keeps what it said last in its turn, and is started again by the next prompt', async () => {
    expect.hasAssertions()
    const run = harness()
    const provider = new AcpAgentProvider('custom', {
      ...run.deps,
      spawn: lateOutput(run.deps.spawn, 300),
    })
    const request = { workspace: { path: workspaceOf() }, providerConfig: customOf('quick-exit') }
    const session = await started(provider, sessionRequest(request))
    const turn = await prompted(session, 'Go on')
    expect(turn).toContainEqual({ type: 'message.delta', kind: 'text', text: HELLO })
    expect(turn).toContainEqual({
      type: 'message.completed',
      role: 'assistant',
      content: [],
      text: HELLO,
    })
    await expect(prompted(session, 'Again')).resolves.toContainEqual(FIRST_RESTART)
  })
})

// Spawns that, from the start given on, run a process that never answers
const silentFrom = (spawn: SpawnFn, start: number): SpawnFn => {
  let starts = 0
  return (command, args, options) => {
    starts += 1
    return starts < start
      ? spawn(command, args, options)
      : spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options)
  }
}

describe('an ACP agent that is not started again in time', () => {
  it('ends the session with a retryable crash that names the time, its group killed', async () => {
    expect.hasAssertions()
    const run = harness()
    const deps = { ...run.deps, spawn: silentFrom(run.deps.spawn, 2), startLimitMs: 300 }
    const request = { workspace: { path: workspaceOf() }, providerConfig: customOf('crash-idle') }
    const session = await started(new AcpAgentProvider('custom', deps), sessionRequest(request))
    await turnThenDeath(session, run)
    const ending = rest(session)
    await session.prompt({ text: 'Again' })
    await expect(ending).resolves.toStrictEqual([
      FIRST_RESTART,
      {
        type: 'session.error',
        kind: 'crash',
        message: 'the agent did not start a session within 300 ms',
        retryable: true,
      },
      { type: 'session.closed' },
    ])
    expect(run.spawned.map(({ child }) => child.signalCode)).toStrictEqual([null, 'SIGKILL'])
  })
})

// A session whose agent died idle after a turn, and the prompt that is starting it again
const restarting = async (): Promise<{
  readonly session: AgentSession
  readonly run: Harness
  readonly prompting: Promise<void>
}> => {
  const { session, run } = await startedWith('crash-idle')
  await turnThenDeath(session, run)
  const prompting = session.prompt({ text: 'Again' })
  await until(session, 'session.warning')
  return { session, run, prompting }
}

describe('a session whose agent is being started again', () => {
  it('cancels the turn of a prompt interrupted while its agent was being started again', async () => {
    expect.hasAssertions()
    const { session, prompting } = await restarting()
    await session.interrupt()
    const events = await until(session, TURN_END, ALLOW)
    await prompting
    expect(events).toContainEqual({ type: 'tool.failed', id: 'call-1', error: 'cancelled' })
    expect(events.at(-1)).toMatchObject({ type: TURN_END, stopReason: 'interrupted' })
  })

  it('gives up, when it closes, the agent it was starting again, waits for its end, and logs no crash of it', async () => {
    expect.hasAssertions()
    const { session, run, prompting } = await restarting()
    await session.close()
    expect(run.spawned.map(({ child }) => child.signalCode)).toStrictEqual([null, 'SIGKILL'])
    await prompting
    expect(run.logged).toStrictEqual([])
  })
})
