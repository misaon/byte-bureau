import type { ModelUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent } from '@bytebureau/plugin-api'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeAgentProvider } from './provider.js'
import type { ClaudeSession } from './session.js'
import { fakeQuery } from './testing/fake-query.js'
import { recordingLogger, sessionRequest } from './testing/requests.js'
import {
  contextMeasured,
  init,
  modelUsage,
  resultSuccess,
  textDelta,
} from './testing/sdk-fixtures.js'
import { rest, start, until } from './testing/session-harness.js'

const TURN_END = 'turn.completed'

// The results of a resumed session: the first carries the totals of the session it resumed, and its own turn in usage
const RESUMED_FIRST: SDKMessage = {
  ...resultSuccess,
  total_cost_usd: 0.05,
  modelUsage: modelUsage(110, 25, 0.05),
}
const RESUMED_SECOND: SDKMessage = {
  ...resultSuccess,
  total_cost_usd: 0.06,
  modelUsage: modelUsage(130, 30, 0.06),
}

// The ends of two turns, prompted one after the other
const twoTurnEnds = async (session: ClaudeSession): Promise<(AgentEvent | undefined)[]> => {
  await session.prompt({ text: 'Go on' })
  const first = await until(session, TURN_END)
  await session.prompt({ text: 'And on' })
  const second = await until(session, TURN_END)
  return [first.at(-1), second.at(-1)]
}

describe('a resumed Claude session', () => {
  it("counts its first turn by the turn's own usage, not by the totals of the session it resumed", async () => {
    expect.hasAssertions()
    const request = sessionRequest({ resume: { providerId: 'claude', ref: 'session-earlier' } })
    const { session, fake } = start({ turns: [[init, RESUMED_FIRST], [RESUMED_SECOND]] }, request)
    const [first, second] = await twoTurnEnds(session)
    expect(fake.options[0]).toHaveProperty('resume', 'session-earlier')
    expect(first).toHaveProperty('usage', {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(second).toMatchObject({
      usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 0 },
    })
    expect(second).toHaveProperty('usage.costUsd', expect.closeTo(0.01, 10))
    await session.close()
  })
})

// A result the mapping cannot read: reading its usage fails
const UNREADABLE_RESULT: SDKMessage = {
  ...resultSuccess,
  get modelUsage(): Record<string, ModelUsage> {
    throw new Error('the usage cannot be read')
  },
}

describe('a turn whose result cannot be read', () => {
  it('still ends, counting nothing, with a warning, and the next turn starts afresh', async () => {
    expect.hasAssertions()
    const { session } = start({ turns: [[init, textDelta, UNREADABLE_RESULT], [textDelta]] })
    await session.prompt({ text: 'Hello' })
    const ended = await until(session, TURN_END)
    expect(ended.slice(-2)).toStrictEqual([
      { type: 'session.warning', kind: 'mapping', message: 'the usage cannot be read' },
      { type: TURN_END, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
    await session.prompt({ text: 'Again' })
    await expect(until(session, 'turn.started')).resolves.toStrictEqual([{ type: 'turn.started' }])
    await session.close()
  })
})

// What the SDK throws when it finds no Claude Code to run, before any process starts
const NO_BINARY = new Error(
  'Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.',
)

describe('a Claude Code that cannot be started', () => {
  it('gives a session that ends with a crash naming the reason, rather than a refused start', async () => {
    expect.hasAssertions()
    const fake = fakeQuery({ throws: NO_BINARY })
    const provider = new ClaudeAgentProvider({
      query: fake.query,
      logger: recordingLogger().logger,
    })
    const session = await provider.createSession(sessionRequest())
    await expect(rest(session)).resolves.toStrictEqual([
      { type: 'session.error', kind: 'crash', message: NO_BINARY.message, retryable: true },
      { type: 'session.closed' },
    ])
    await session.close()
  })
})

describe('the context a turn leaves in use', () => {
  it('is measured after every turn, by a summary that makes no request, and told with the usage', async () => {
    expect.hasAssertions()
    const { session, fake } = start({ turns: [[init, resultSuccess]], context: contextMeasured })
    await session.prompt({ text: 'Hello' })
    const ended = await until(session, TURN_END)
    expect(ended.at(-1)).toHaveProperty('usage.contextPct', 25)
    expect(fake.contextDetails).toStrictEqual(['summary'])
    await session.close()
  })

  it('is left out when the SDK cannot tell it', async () => {
    expect.hasAssertions()
    const { session } = start({ turns: [[init, resultSuccess]], context: new Error('no measure') })
    await session.prompt({ text: 'Hello' })
    const ended = await until(session, TURN_END)
    expect(ended.at(-1)).not.toHaveProperty('usage.contextPct')
    await session.close()
  })

  it('is given up after 5 s, and the turn ends without it', async () => {
    expect.hasAssertions()
    vi.useFakeTimers()
    try {
      const { session } = start({ turns: [[init, resultSuccess]], context: 'hangs' })
      await session.prompt({ text: 'Hello' })
      await vi.advanceTimersByTimeAsync(5000)
      const ended = await until(session, TURN_END)
      expect(ended.at(-1)).not.toHaveProperty('usage.contextPct')
      await session.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a permission prompt the SDK takes back', () => {
  it('is answered as denied, so the agent does not wait on it', async () => {
    expect.hasAssertions()
    const cancelled = {
      ask: { toolName: 'Bash', input: {}, requestId: 'req-1', cancel: true },
    } as const
    const { session, fake } = start({ turns: [[init, cancelled, resultSuccess]] })
    await session.prompt({ text: 'Hello' })
    await until(session, TURN_END)
    expect(fake.permissions).toStrictEqual([{ behavior: 'deny', message: 'cancelled' }])
    await session.close()
  })
})
