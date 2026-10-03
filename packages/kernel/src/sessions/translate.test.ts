import {
  KernelEventSchemas,
  type AgentEvent,
  type Ask,
  type KernelEvent,
} from '@bytebureau/protocol'
import { Result, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { translate, type Lookups, type TurnRef } from './translate.js'

const turn: TurnRef = { turnId: 'turn-1', index: 2 }
const usage = { inputTokens: 3, outputTokens: 4 }
const content = [{ type: 'text', text: 'Hi' }]

// The payload must also fit the protocol schema of the event it is published as
const fits = (event: KernelEvent | null): boolean =>
  event !== null &&
  Result.isSuccess(Schema.decodeUnknownResult(KernelEventSchemas[event.type])(event.payload))

const named = (toolId: string): string => (toolId === 'tool-1' ? 'Write' : '')
const known: Lookups = { toolName: named, profileId: 'profile-1' }

const completed: AgentEvent = {
  type: 'tool.completed',
  id: 'tool-1',
  outputSummary: 'ok',
  bytes: 2,
}
const failed: AgentEvent = { type: 'tool.failed', id: 'tool-1', error: 'boom' }

type Mapping = readonly [string, AgentEvent, KernelEvent]

const MAPPINGS: readonly Mapping[] = [
  [
    'a started turn',
    { type: 'turn.started' },
    { type: 'turn.started', payload: { turnId: 'turn-1', index: 2, status: 'running' } },
  ],
  [
    'a thinking delta',
    { type: 'message.delta', kind: 'thinking', text: 'hm' },
    { type: 'message.assistant.delta', payload: { kind: 'thinking', text: 'hm' } },
  ],
  [
    'a completed assistant message',
    { type: 'message.completed', role: 'assistant', content, text: 'Hi' },
    { type: 'message.assistant.completed', payload: { text: 'Hi', content } },
  ],
  [
    'the start of a tool call',
    { type: 'tool.started', id: 'tool-1', name: 'Write', kind: 'builtin', input: { path: 'a.ts' } },
    {
      type: 'tool.started',
      payload: { id: 'tool-1', name: 'Write', kind: 'builtin', input: { path: 'a.ts' } },
    },
  ],
  [
    'a started subagent',
    { type: 'subagent.started', id: 'a', name: 'Plan' },
    { type: 'subagent.started', payload: { id: 'a', name: 'Plan' } },
  ],
  [
    'a stopped subagent',
    { type: 'subagent.stopped', id: 'a', name: 'Plan' },
    { type: 'subagent.stopped', payload: { id: 'a', name: 'Plan' } },
  ],
  [
    'the start of a compaction',
    { type: 'compaction.started' },
    { type: 'compaction.started', payload: {} },
  ],
  [
    'the end of a compaction',
    { type: 'compaction.completed' },
    { type: 'compaction.completed', payload: {} },
  ],
  [
    'a usage report',
    { type: 'usage.updated', usage },
    { type: 'usage.updated', payload: { usage } },
  ],
  [
    'a rate limit report',
    { type: 'ratelimit.updated', rateLimit: { fiveHourPct: 40 } },
    { type: 'ratelimit.updated', payload: { profileId: null, rateLimit: { fiveHourPct: 40 } } },
  ],
  [
    'a warning',
    { type: 'session.warning', kind: 'retry', message: 'again' },
    { type: 'session.warning', payload: { kind: 'retry', message: 'again' } },
  ],
]

describe(translate, () => {
  it.each(MAPPINGS)('maps %s one to one', (_title, event, expected) => {
    expect(translate(event, turn)).toStrictEqual(expected)
  })

  it('produces payloads the protocol schemas accept', () => {
    const translated = MAPPINGS.map(([, event]) => translate(event, turn))
    expect(translated.every((event) => fits(event))).toBe(true)
  })

  it('drops the message of a user', () => {
    const user: AgentEvent = { type: 'message.completed', role: 'user', content, text: 'Hi' }
    expect(translate(user, turn)).toBeNull()
  })
})

describe('translate without a running turn', () => {
  it('has nothing to say about a started turn', () => {
    expect(translate({ type: 'turn.started' }, null)).toBeNull()
  })

  it('still maps what does not belong to a turn', () => {
    expect(translate({ type: 'usage.updated', usage }, null)).toStrictEqual({
      type: 'usage.updated',
      payload: { usage },
    })
  })
})

describe('translate a rate limit', () => {
  it('files it under the profile the session runs under when it is told', () => {
    const limited: AgentEvent = { type: 'ratelimit.updated', rateLimit: { sevenDayPct: 9 } }
    expect(translate(limited, turn, known)).toStrictEqual({
      type: 'ratelimit.updated',
      payload: { profileId: 'profile-1', rateLimit: { sevenDayPct: 9 } },
    })
  })
})

describe('translate a finished tool call', () => {
  it('leaves the name empty unless it is told', () => {
    expect(translate(completed, turn)).toStrictEqual({
      type: 'tool.completed',
      payload: { id: 'tool-1', name: '', outputSummary: 'ok', bytes: 2 },
    })
    expect(translate(failed, turn)).toStrictEqual({
      type: 'tool.failed',
      payload: { id: 'tool-1', name: '', error: 'boom' },
    })
  })

  it('names a completed call and a failed one after the lookup', () => {
    expect(translate(completed, turn, known)).toStrictEqual({
      type: 'tool.completed',
      payload: { id: 'tool-1', name: 'Write', outputSummary: 'ok', bytes: 2 },
    })
    expect(translate(failed, turn, known)).toStrictEqual({
      type: 'tool.failed',
      payload: { id: 'tool-1', name: 'Write', error: 'boom' },
    })
  })
})

const ask: Ask = {
  id: 'ask-1',
  sessionId: 'session-1',
  turnId: null,
  kind: 'question',
  title: 'Which?',
  questions: [],
  policy: { onTimeout: 'wait', timeout: '30m' },
  recommendationSource: 'none',
  status: 'pending',
  createdAt: '2026-10-03T00:00:00.000Z',
  deadlineAt: null,
}

describe('translate what the session manager handles itself', () => {
  const handled: readonly AgentEvent[] = [
    { type: 'ask.requested', ask },
    { type: 'turn.completed', stopReason: 'end_turn', usage },
    { type: 'session.error', kind: 'crash', message: 'x', retryable: true },
    { type: 'session.closed' },
    { type: 'raw', providerEvent: {} },
  ]

  it.each(handled)('leaves out $type', (event) => {
    expect(translate(event, turn)).toBeNull()
  })
})
