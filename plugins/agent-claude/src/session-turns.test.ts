import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent } from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import type { ClaudeSession } from './session.js'
import { sessionRequest } from './testing/requests.js'
import { init, modelUsage, resultSuccess } from './testing/sdk-fixtures.js'
import { start, until } from './testing/session-harness.js'

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
