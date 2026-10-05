import type { SessionUpdate, ToolKind } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { mapUpdate } from './mapping.js'

const SUMMARY_LIMIT = 32 * 1024

const message: SessionUpdate = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: 'Creating ' },
}
const thought: SessionUpdate = {
  sessionUpdate: 'agent_thought_chunk',
  content: { type: 'text', text: 'the user wants a file' },
}
const picture: SessionUpdate = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
}
const echo: SessionUpdate = {
  sessionUpdate: 'user_message_chunk',
  content: { type: 'text', text: 'Create src/hello.ts' },
}

const toolCall = (kind?: ToolKind): SessionUpdate => ({
  sessionUpdate: 'tool_call',
  toolCallId: 'call-1',
  title: 'Run the tests',
  ...(kind === undefined ? {} : { kind }),
  status: 'pending',
  rawInput: { command: 'bun test' },
})

// The event of a tool that ended well, with its summary and size
const toolCompleted = (outputSummary: string, bytes: number, id = 'call-1'): unknown => ({
  type: 'tool.completed',
  id,
  outputSummary,
  bytes,
})

const completed = (
  fields: Partial<Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>>,
): SessionUpdate => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call-1',
  status: 'completed',
  ...fields,
})

describe('the text an agent streams', () => {
  it('tells message chunks as text deltas and thought chunks as thinking deltas', () => {
    expect(mapUpdate(message)).toStrictEqual([
      { type: 'message.delta', kind: 'text', text: 'Creating ' },
    ])
    expect(mapUpdate(thought)).toStrictEqual([
      { type: 'message.delta', kind: 'thinking', text: 'the user wants a file' },
    ])
  })

  it('leaves out a chunk that is not text, and the echo of the prompt', () => {
    expect([...mapUpdate(picture), ...mapUpdate(echo)]).toStrictEqual([])
  })
})

const started = (kind: 'bash' | 'builtin'): unknown => ({
  type: 'tool.started',
  id: 'call-1',
  name: 'Run the tests',
  kind,
  input: { command: 'bun test' },
})
const OTHER_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'fetch',
  'think',
  'other',
  'switch_mode',
  undefined,
] as const

describe('the tools an agent starts', () => {
  it('tells a tool call as started, a command as bash and every other kind as builtin', () => {
    expect(mapUpdate(toolCall('execute'))).toStrictEqual([started('bash')])
    const mapped = OTHER_KINDS.flatMap((kind) => mapUpdate(toolCall(kind)))
    expect(mapped).toStrictEqual(OTHER_KINDS.map(() => started('builtin')))
  })

  it('tells a tool call without input with a null input, and one that comes already over as ended too', () => {
    const ended: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-2',
      title: 'Think',
      status: 'completed',
    }
    expect(mapUpdate(ended)).toStrictEqual([
      { type: 'tool.started', id: 'call-2', name: 'Think', kind: 'builtin', input: null },
      toolCompleted('', 0, 'call-2'),
    ])
  })
})

describe('the tools an agent ends', () => {
  it('tells a completed update with the text of its content, else of its raw output', () => {
    const content = completed({
      content: [
        { type: 'content', content: { type: 'text', text: 'line 1\n' } },
        { type: 'diff', path: '/w/src/a.ts', newText: 'export {}' },
        { type: 'content', content: { type: 'text', text: 'line 2' } },
      ],
      rawOutput: 'not this',
    })
    expect(mapUpdate(content)).toStrictEqual([toolCompleted('line 1\nline 2', 13)])
    expect(mapUpdate(completed({ rawOutput: 'žluť' }))).toStrictEqual([toolCompleted('žluť', 6)])
    expect(mapUpdate(completed({ rawOutput: { exitCode: 0 } }))).toStrictEqual([
      toolCompleted('{"exitCode":0}', 14),
    ])
  })

  it('cuts the summary of a long output at 32 KB and counts every byte of it', () => {
    const [event] = mapUpdate(completed({ rawOutput: 'x'.repeat(40_000) }))
    expect(event).toStrictEqual(toolCompleted('x'.repeat(SUMMARY_LIMIT), 40_000))
  })

  it('tells a failed update as a failed tool, and leaves out one still running', () => {
    expect(mapUpdate(completed({ status: 'failed', rawOutput: 'denied' }))).toStrictEqual([
      { type: 'tool.failed', id: 'call-1', error: 'denied' },
    ])
    expect(mapUpdate(completed({ status: 'in_progress' }))).toStrictEqual([])
    expect(mapUpdate(completed({ status: null }))).toStrictEqual([])
  })
})

describe('the rest of what an agent reports', () => {
  it('tells a plan as a warning of its own kind, with its entries', () => {
    const entries = [
      { content: 'Write src/hello.ts', priority: 'high', status: 'pending' },
    ] as const
    expect(mapUpdate({ sessionUpdate: 'plan', entries: [...entries] })).toStrictEqual([
      { type: 'session.warning', kind: 'plan', message: JSON.stringify(entries) },
    ])
  })

  it('leaves out commands, modes, config options, the session info, plan changes and the context it measures', () => {
    const ignored: SessionUpdate[] = [
      {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'plan', description: 'Plan' }],
      },
      { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
      { sessionUpdate: 'session_info_update', title: 'Hello' },
      { sessionUpdate: 'usage_update', used: 1000, size: 200_000 },
      { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'plan-1', entries: [] } },
      { sessionUpdate: 'plan_removed', planId: 'plan-1' },
      { sessionUpdate: 'config_option_update', configOptions: [] },
    ]
    expect(ignored.flatMap((update) => mapUpdate(update))).toStrictEqual([])
  })
})

describe('the bytebureau extensions of _meta', () => {
  it('tells the usage and the rate limit an update carries, after what the update itself tells', () => {
    const usage = { inputTokens: 7, outputTokens: 3, costUsd: 0.01 }
    const rateLimit = { fiveHourPct: 40, fiveHourResetsAt: '2026-10-05T12:00:00Z' }
    const meta = { 'bytebureau.usage': usage, 'bytebureau.rateLimit': rateLimit, 'zed.dev': true }
    expect(mapUpdate(completed({ rawOutput: 'ok', _meta: meta }))).toStrictEqual([
      toolCompleted('ok', 2),
      { type: 'usage.updated', usage },
      { type: 'ratelimit.updated', rateLimit },
    ])
    const onIgnored: SessionUpdate = {
      sessionUpdate: 'current_mode_update',
      currentModeId: 'code',
      _meta: meta,
    }
    expect(mapUpdate(onIgnored)).toHaveLength(2)
  })

  it('leaves out an extension it cannot read, and a rate limit that names no window', () => {
    const meta = {
      'bytebureau.usage': { inputTokens: -1, outputTokens: 'three' },
      'bytebureau.rateLimit': {},
    }
    expect(mapUpdate({ ...message, _meta: meta })).toStrictEqual([
      { type: 'message.delta', kind: 'text', text: 'Creating ' },
    ])
    expect(mapUpdate({ ...message, _meta: null })).toHaveLength(1)
  })
})
