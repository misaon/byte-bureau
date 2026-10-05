import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { ClaudeSession } from './session.js'
import { subagentHook } from './testing/fake-query.js'
import { CANARY_KEY, sessionRequest } from './testing/requests.js'
import {
  SESSION,
  assistantWithTool,
  init,
  resultInterrupted,
  resultSuccess,
  textDelta,
  toolResult,
} from './testing/sdk-fixtures.js'
import { rest, start, until } from './testing/session-harness.js'

const TURN_END = 'turn.completed'

const PROMPTED: SDKUserMessage = {
  type: 'user',
  message: { role: 'user', content: 'Create src/hello.ts' },
  parent_tool_use_id: null,
}
const ONE_TURN_TYPES = [
  'turn.started',
  'message.delta',
  'message.completed',
  'tool.started',
  'tool.completed',
  'usage.updated',
  TURN_END,
]

describe(ClaudeSession, () => {
  it('sends a prompt as a user message of its one query, and tells the turn in canonical events', async () => {
    expect.hasAssertions()
    const { session, fake } = start({
      turns: [[init, textDelta, assistantWithTool, toolResult, resultSuccess]],
    })
    expect(session.externalRef).toBeNull()
    await session.prompt({ text: 'Create src/hello.ts' })
    const events = await until(session, TURN_END)
    expect(events.map((event) => event.type)).toStrictEqual(ONE_TURN_TYPES)
    expect(fake.prompts).toStrictEqual([PROMPTED])
    expect(session.externalRef).toStrictEqual({ providerId: 'claude', ref: SESSION })
    await session.close()
  })

  it('asks the kernel what the agent asks to do, and gives the agent the answer', async () => {
    expect.hasAssertions()
    const { session, fake } = start({
      turns: [
        [
          init,
          { ask: { toolName: 'Bash', input: { command: 'ls' }, requestId: 'req-1' } },
          resultSuccess,
        ],
      ],
    })
    await session.prompt({ text: 'List the files' })
    const asked = await until(session, 'ask.requested')
    expect(asked.at(-1)).toMatchObject({ ask: { id: 'req-1', kind: 'permission' } })
    await session.answer('req-1', { selected: ['allow'] })
    await until(session, TURN_END)
    expect(fake.permissions).toStrictEqual([{ behavior: 'allow', updatedInput: { command: 'ls' } }])
    await session.close()
  })

  it('switches the model of its query', async () => {
    expect.hasAssertions()
    const { session, fake } = start({})
    await session.setModel('claude-fable-5')
    expect(fake.models).toStrictEqual(['claude-fable-5'])
    await session.close()
  })
})

describe('an interrupted Claude session', () => {
  it('denies what waits for an answer, interrupts the agent and ends the turn as interrupted', async () => {
    expect.hasAssertions()
    const { session, fake } = start({
      turns: [
        [init, { ask: { toolName: 'Edit', input: {}, requestId: 'req-2' } }, resultInterrupted],
      ],
    })
    await session.prompt({ text: 'Edit it' })
    await until(session, 'ask.requested')
    await session.interrupt()
    const ended = await until(session, TURN_END)
    expect(ended.at(-1)).toMatchObject({ stopReason: 'interrupted' })
    expect(fake.permissions).toStrictEqual([{ behavior: 'deny', message: 'interrupted' }])
    expect(fake.calls.interrupt).toBe(1)
    await session.close()
  })

  it('tells the subagents the agent starts and stops, as its hooks report them', async () => {
    expect.hasAssertions()
    const hooks = [
      subagentHook('SubagentStart', 'agent-1', 'Explore'),
      subagentHook('SubagentStop', 'agent-1', 'Explore'),
    ]
    const { session } = start({ turns: [[init, ...hooks, resultSuccess]] })
    await session.prompt({ text: 'Look around' })
    const events = await until(session, TURN_END)
    expect(events.filter((event) => event.type.startsWith('subagent.'))).toStrictEqual([
      { type: 'subagent.started', id: 'agent-1', name: 'Explore' },
      { type: 'subagent.stopped', id: 'agent-1', name: 'Explore' },
    ])
    await session.close()
  })
})

describe('the end of a Claude session', () => {
  it('aborts the query on close, ends the events with session.closed, and closes once', async () => {
    expect.hasAssertions()
    const { session, fake } = start({ turns: [[init, resultSuccess]] })
    await session.prompt({ text: 'Hello' })
    await until(session, TURN_END)
    await session.close()
    await session.close()
    await session.ended
    await expect(rest(session)).resolves.toStrictEqual([{ type: 'session.closed' }])
    expect(fake.options[0]).toHaveProperty('abortController.signal.aborted', true)
    expect(fake.calls.close).toBe(1)
  })

  it('tells a query that fails as a crash of the session, then ends, and names the session in its warning', async () => {
    expect.hasAssertions()
    const request = sessionRequest()
    const crashing = [[init, textDelta, { fail: new Error('the CLI exited with 1') }]]
    const { session, logged } = start({ turns: crashing }, request)
    await session.prompt({ text: 'Hello' })
    const events = await rest(session)
    expect(events.slice(-2)).toStrictEqual([
      { type: 'session.error', kind: 'crash', message: 'the CLI exited with 1', retryable: true },
      { type: 'session.closed' },
    ])
    const named = { sessionId: request.sessionId, ref: SESSION, reason: 'the CLI exited with 1' }
    expect(logged).toStrictEqual([
      { level: 'warn', message: 'the Claude query ended with an error', properties: named },
    ])
  })
})

const LOGIN_DIR = {
  id: 'claude/work',
  providerId: 'claude',
  kind: 'login',
  configDir: '/h/profiles/claude/work',
} as const
const API_KEY = { id: 'claude/ci', providerId: 'claude', kind: 'api_key' } as const

// A tool result the mapping cannot read: reading its content fails
const unreadable: SDKUserMessage = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        get content(): string {
          throw new Error('the content cannot be read')
        },
      },
    ],
  },
  parent_tool_use_id: null,
}

describe('what a Claude session hands the SDK', () => {
  it('gives the agent the environment of the request, and the directory of a login profile', async () => {
    expect.hasAssertions()
    const request = sessionRequest({ profile: LOGIN_DIR })
    const { session, fake } = start({}, request)
    expect(fake.options[0]).toHaveProperty('env', {
      ...request.env,
      CLAUDE_CONFIG_DIR: '/h/profiles/claude/work',
    })
    await session.close()
  })

  it('tells an SDK message it cannot read as a warning and goes on', async () => {
    expect.hasAssertions()
    const { session } = start({ turns: [[init, unreadable, resultSuccess]] })
    await session.prompt({ text: 'Hello' })
    const events = await until(session, TURN_END)
    expect(events[0]).toStrictEqual({
      type: 'session.warning',
      kind: 'mapping',
      message: 'the content cannot be read',
    })
    await session.close()
  })

  it('never lets the API key of the request into an event or a log line', async () => {
    expect.hasAssertions()
    const request = sessionRequest({
      profile: API_KEY,
      env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: CANARY_KEY },
    })
    const turn = [
      init,
      textDelta,
      { ask: { toolName: 'Bash', input: { command: 'env' }, requestId: 'req-9' } },
      { fail: new Error('crashed') },
    ]
    const { session, fake, logged } = start({ turns: [turn] }, request)
    await session.prompt({ text: 'Show the environment' })
    await until(session, 'ask.requested')
    await session.answer('req-9', { selected: ['deny'] })
    const told = JSON.stringify([await rest(session), logged])
    expect(fake.options[0]).toHaveProperty('env.ANTHROPIC_API_KEY', CANARY_KEY)
    expect(told).not.toContain(CANARY_KEY)
  })
})
