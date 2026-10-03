import { existsSync } from 'node:fs'
import type { EventEnvelope } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { QUIET } from './facade/facade-fixtures.js'
import { createKernelFrom, type Kernel } from './facade.js'
import { KernelTest } from './kernel-test.js'
import { helloFileOf } from './sessions/session-helper-fixtures.js'
import type { Session } from './sessions/types.js'
import { createTempRepo, tempDir } from './testing/temp-repo.js'

// The fake agent asks whether it may write; the answer is the one it offers
async function answerTheAsk(kernel: Kernel, sessionId: string): Promise<void> {
  const [ask] = await kernel.asks.pending(sessionId)
  if (ask === undefined) {
    throw new Error('the agent asked, yet no ask is pending')
  }
  await kernel.asks.answer(ask.id, { selected: ['yes'] }, 'cli')
}

// What the CLI does with a run: follow the events, answer the question, complete the session once its turn is over
async function followRun(
  kernel: Kernel,
  sessionId: string,
  events: AsyncIterable<EventEnvelope>,
): Promise<readonly string[]> {
  const seen: string[] = []
  for await (const event of events) {
    seen.push(event.type)
    if (event.type === 'ask.requested') {
      await answerTheAsk(kernel, sessionId)
    }
    if (event.type === 'turn.completed') {
      await kernel.sessions.complete(sessionId)
    }
    if (event.type === 'session.completed') {
      break
    }
  }
  return seen
}

interface Run {
  readonly session: Session
  readonly seen: readonly string[]
  readonly turns: number
}

// A session of the fake agent, from its registration to its completion
async function runFakeSession(kernel: Kernel): Promise<Run> {
  const project = await kernel.projects.register(createTempRepo())
  const input = { projectId: project.id, title: 'facade run', providerId: 'fake' }
  const session = await kernel.sessions.create(input)
  const events = kernel.events.subscribe({ sessionId: session.id, since: 0 })
  await kernel.sessions.prompt(session.id, { text: 'go' })
  const seen = await followRun(kernel, session.id, events)
  const usage = await kernel.usage.session(session.id)
  return { session, seen, turns: usage.turns }
}

describe(createKernelFrom, () => {
  it('drives a whole fake-provider run through Promises and AsyncIterables only', async () => {
    expect.hasAssertions()
    const home = tempDir('bb-home-')
    const kernel = await createKernelFrom(KernelTest({ home }), { home, env: {}, logging: QUIET })
    try {
      const { session, seen, turns } = await runFakeSession(kernel)
      expect(seen).toContain('ask.answered')
      expect(turns).toBe(1)
      expect(existsSync(helloFileOf(session))).toBe(true)
      expect(kernel.providers.list().map((provider) => provider.id)).toContain('fake')
    } finally {
      await kernel.close()
    }
  })
})
