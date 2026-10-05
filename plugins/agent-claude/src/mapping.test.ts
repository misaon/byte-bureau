import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { mapMessage, newMapState, toolKindOf } from './mapping.js'
import {
  SESSION,
  assistantWithTool,
  authExpired,
  authFailed,
  compacted,
  init,
  rateLimited,
  resultMaxTurns,
  resultSuccess,
  retried,
  textDelta,
  thinkingDelta,
  toolFailed,
  toolResult,
} from './testing/sdk-fixtures.js'

const DELTA = 'message.delta'
const TURN_END = 'turn.completed'

const ONE_TURN = [init, textDelta, thinkingDelta, assistantWithTool, toolResult, resultSuccess]
const ONE_TURN_TYPES = [
  'turn.started',
  DELTA,
  DELTA,
  'message.completed',
  'tool.started',
  'tool.completed',
  'usage.updated',
  TURN_END,
]
const FIRST_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  costUsd: 0.0123,
}
const RESETS_AT = new Date(1_791_100_000 * 1000).toISOString()
const RETRY_WARNING = 'attempt 1 of 3 in 2000 ms: overloaded (529)'
const LAPSED = 'Failed to authenticate: OAuth session expired and could not be refreshed'

describe(mapMessage, () => {
  it('turns the messages of one turn into the canonical events, starting the turn at the first delta', () => {
    expect.hasAssertions()
    const state = newMapState()
    const events = ONE_TURN.flatMap((message) => mapMessage(message, state))
    expect(events.map((event) => event.type)).toStrictEqual(ONE_TURN_TYPES)
    expect(events[1]).toStrictEqual({ type: DELTA, kind: 'text', text: 'Hello' })
    expect(events[4]).toMatchObject({ id: 'toolu_1', name: 'Edit', kind: 'builtin' })
    expect(events[7]).toStrictEqual({
      type: TURN_END,
      stopReason: 'end_turn',
      usage: FIRST_USAGE,
    })
    expect(state.sessionId).toBe(SESSION)
  })

  it('tells an error result by its subtype, and a rate limit as both an update and a pause-worthy error', () => {
    expect.hasAssertions()
    const state = newMapState()
    expect(mapMessage(resultMaxTurns, state).at(-1)).toMatchObject({
      type: TURN_END,
      stopReason: 'error_max_turns',
    })
    const limited = mapMessage(rateLimited, state)
    expect(limited.map((event) => event.type)).toStrictEqual(['ratelimit.updated', 'session.error'])
    expect(limited[0]).toMatchObject({
      rateLimit: { fiveHourPct: 100, fiveHourResetsAt: RESETS_AT },
    })
  })
})

describe('the warnings and errors of a session', () => {
  it('tells a compaction, a retry and a lost login', () => {
    expect.hasAssertions()
    const state = newMapState()
    expect(mapMessage(compacted, state)).toStrictEqual([{ type: 'compaction.completed' }])
    expect(mapMessage(retried, state)).toStrictEqual([
      { type: 'session.warning', kind: 'api_retry', message: RETRY_WARNING },
    ])
    expect(mapMessage(authFailed, state)).toStrictEqual([
      { type: 'session.error', kind: 'auth', message: 'Not logged in', retryable: false },
    ])
  })

  it('tells a lapsed login, which comes on an assistant message, as an auth error', () => {
    expect.hasAssertions()
    expect(mapMessage(authExpired, newMapState())).toStrictEqual([
      { type: 'turn.started' },
      { type: 'session.error', kind: 'auth', message: LAPSED, retryable: false },
    ])
  })

  it('names the kind of a tool by its name, and tells a tool that failed by its error', () => {
    expect.hasAssertions()
    const names = ['Bash', 'Task', 'Skill', 'mcp__jira__search', 'Read']
    expect(names.map((name) => toolKindOf(name))).toStrictEqual([
      'bash',
      'subagent',
      'skill',
      'mcp',
      'builtin',
    ])
    expect(mapMessage(toolFailed, newMapState())).toStrictEqual([
      { type: 'tool.failed', id: 'toolu_1', error: 'permission denied' },
    ])
  })
})

const HIDDEN: readonly SDKMessage[] = [
  { type: 'system', subtype: 'status', status: 'requesting', session_id: SESSION, uuid: init.uuid },
  {
    type: 'user',
    message: { role: 'user', content: '[Request interrupted by user]' },
    parent_tool_use_id: null,
  },
  {
    type: 'auth_status',
    isAuthenticating: true,
    output: ['Opening the browser'],
    session_id: SESSION,
    uuid: init.uuid,
  },
]

describe('the messages a session does not show', () => {
  it('maps them to nothing', () => {
    expect.hasAssertions()
    const state = newMapState()
    expect(HIDDEN.flatMap((message) => mapMessage(message, state))).toStrictEqual([])
  })
})
