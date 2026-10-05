import type { AgentSession } from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import type { FakeScript } from './testing/fake-acp-agent.js'
import { endOf, harness, rest, until, type Harness } from './testing/session-harness.js'
import { customOf, sessionOf, TURN_END, workspaceOf } from './testing/sessions.js'

const ALLOW = { selected: ['allow'] }

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
    expect(events[0]).toStrictEqual({
      type: 'session.warning',
      kind: 'restart',
      message: 'the agent exited idle; starting it again (1 of 3)',
    })
    expect(events.slice(1).map((event) => event.type)).toContain(TURN_END)
    expect(run.spawned).toHaveLength(2)
  })

  it('cancels the turn of a prompt interrupted while its agent was being started again', async () => {
    expect.hasAssertions()
    const { session, run } = await startedWith('crash-idle')
    await turnThenDeath(session, run)
    const prompting = session.prompt({ text: 'Again' })
    await until(session, 'session.warning')
    await session.interrupt()
    const events = await until(session, TURN_END, ALLOW)
    await prompting
    expect(events).toContainEqual({ type: 'tool.failed', id: 'call-1', error: 'cancelled' })
    expect(events.at(-1)).toMatchObject({ type: TURN_END, stopReason: 'interrupted' })
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
