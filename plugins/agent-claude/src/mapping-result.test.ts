import type { SDKMessage, SDKRateLimitEvent } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { mapMessage, newMapState } from './mapping.js'
import {
  assistantWithTool,
  modelUsage,
  rateLimited,
  resultApiError,
  resultInterrupted,
  resultSuccess,
  textDelta,
} from './testing/sdk-fixtures.js'

const DELTA = 'message.delta'
const TURN_END = 'turn.completed'
const RESETS_AT = new Date(1_791_100_000 * 1000).toISOString()

const SECOND_RESULT: SDKMessage = {
  ...resultSuccess,
  total_cost_usd: 0.03,
  modelUsage: modelUsage(25, 9, 0.03),
}

describe('the end of a turn', () => {
  it('counts each turn on its own, as the SDK reports the totals of the whole query', () => {
    expect.hasAssertions()
    const state = newMapState()
    mapMessage(resultSuccess, state)
    const [, completed] = mapMessage(SECOND_RESULT, state)
    expect(completed).toMatchObject({
      type: TURN_END,
      usage: { inputTokens: 15, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
    expect(completed).toHaveProperty('usage.costUsd', expect.closeTo(0.0177, 10))
  })

  it('ends an interrupted turn as interrupted, and a turn that failed on the API by its stop reason', () => {
    expect.hasAssertions()
    const state = newMapState()
    expect(mapMessage(resultInterrupted, state).at(-1)).toMatchObject({
      stopReason: 'interrupted',
    })
    expect(mapMessage(resultApiError, state).at(-1)).toMatchObject({
      stopReason: 'stop_sequence',
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  })

  it('starts the next turn afresh once a turn has ended', () => {
    expect.hasAssertions()
    const state = newMapState()
    const events = [textDelta, resultSuccess, textDelta].flatMap((message) =>
      mapMessage(message, state),
    )
    expect(events.map((event) => event.type)).toStrictEqual([
      'turn.started',
      DELTA,
      'usage.updated',
      TURN_END,
      'turn.started',
      DELTA,
    ])
  })
})

const WEEKLY: SDKRateLimitEvent = {
  ...rateLimited,
  rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.25 },
}
const OVERAGE: SDKRateLimitEvent = {
  ...rateLimited,
  rate_limit_info: { status: 'allowed', rateLimitType: 'overage' },
}
const CONTEXT_USAGE = {
  model: 'claude-opus-5-5',
  total_tokens: 50_000,
  raw_max_tokens: 200_000,
  percentage: 25,
  categories: [],
  mcp_tools: [],
  memory_files: [],
  agents: [],
}

describe('the usage of a session', () => {
  it('keeps both windows of the rate limit, and says nothing of an event that names neither', () => {
    expect.hasAssertions()
    const state = newMapState()
    mapMessage(rateLimited, state)
    expect(mapMessage(WEEKLY, state)).toStrictEqual([
      {
        type: 'ratelimit.updated',
        rateLimit: { fiveHourPct: 100, fiveHourResetsAt: RESETS_AT, sevenDayPct: 25 },
      },
    ])
    expect(mapMessage(OVERAGE, state)).toStrictEqual([])
  })

  it('reports the share of the context a turn used, when the SDK told it', () => {
    expect.hasAssertions()
    const state = newMapState()
    mapMessage({ ...assistantWithTool, context_usage: CONTEXT_USAGE }, state)
    expect(mapMessage(resultSuccess, state).at(-1)).toHaveProperty('usage.contextPct', 25)
    expect(mapMessage(resultSuccess, state).at(-1)).not.toHaveProperty('usage.contextPct')
  })
})
