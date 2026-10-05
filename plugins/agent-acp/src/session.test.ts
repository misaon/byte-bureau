import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { until } from './testing/session-harness.js'
import { customOf, prompted, sessionOf, TURN_END, workspaceOf } from './testing/sessions.js'

const HELLO_TYPES = [
  'turn.started',
  'message.delta',
  'message.delta',
  'tool.started',
  'ask.requested',
  'tool.completed',
  'usage.updated',
  'message.completed',
  TURN_END,
]

describe('a session of an ACP agent', () => {
  it('runs a prompt through a real ACP agent: thinking, text, a permission brokered as an ask, the file written inside the workspace, usage from _meta', async () => {
    expect.hasAssertions()
    const workspace = workspaceOf()
    const session = await sessionOf({
      workspace: { path: workspace },
      providerConfig: customOf('hello'),
    })
    const seen = await prompted(session, 'Create src/hello.ts')
    expect(seen.map((event) => event.type)).toStrictEqual(HELLO_TYPES)
    expect(seen[1]).toStrictEqual({ type: 'message.delta', kind: 'thinking', text: 'thinking' })
    expect(readFileSync(path.join(workspace, 'src', 'hello.ts'), 'utf8')).toContain(
      'export function hello',
    )
    expect(session.externalRef).toStrictEqual({ providerId: 'acp:custom', ref: 'fake-acp-1' })
    await session.close()
  })

  it('ends the turn with the text the agent said and the usage it reported', async () => {
    expect.hasAssertions()
    const providerConfig = customOf('hello')
    const session = await sessionOf({ workspace: { path: workspaceOf() }, providerConfig })
    const seen = await prompted(session, 'Create src/hello.ts')
    expect(seen.slice(-2)).toStrictEqual([
      { type: 'message.completed', role: 'assistant', content: [], text: 'hello; api key absent' },
      { type: TURN_END, stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 3 } },
    ])
    expect(seen).toContainEqual({
      type: 'tool.started',
      id: 'call-1',
      name: 'Write src/hello.ts',
      kind: 'builtin',
      input: { path: 'src/hello.ts' },
    })
  })

  it('refuses a read outside the workspace, so the agent gets an error instead of the file', async () => {
    expect.hasAssertions()
    const workspace = workspaceOf()
    writeFileSync(path.join(workspace, '..', 'outside.txt'), 'the outside secret')
    const session = await sessionOf({
      workspace: { path: workspace },
      providerConfig: customOf('escape'),
    })
    const seen = await prompted(session, 'Read ../outside.txt')
    const error = `Invalid params: ${workspace}/../outside.txt is outside the workspace`
    expect(seen).toContainEqual({ type: 'tool.failed', id: 'call-2', error })
    expect(JSON.stringify(seen)).not.toContain('the outside secret')
  })
})

describe('a session of an ACP agent at work', () => {
  it('cancels a slow turn on interrupt and ends it as interrupted', async () => {
    expect.hasAssertions()
    const session = await sessionOf({
      workspace: { path: workspaceOf() },
      providerConfig: customOf('slow'),
    })
    const prompting = session.prompt({ text: 'Take your time' })
    await until(session, 'turn.started')
    await session.interrupt()
    const ended = await until(session, TURN_END)
    await prompting
    const usage = { inputTokens: 0, outputTokens: 0 }
    expect(ended.at(-1)).toStrictEqual({ type: TURN_END, stopReason: 'interrupted', usage })
  })

  it('serves a terminal to the agent inside the workspace and gives it the output', async () => {
    expect.hasAssertions()
    const providerConfig = customOf('terminal')
    const session = await sessionOf({ workspace: { path: workspaceOf() }, providerConfig })
    await expect(prompted(session, 'Run node')).resolves.toContainEqual({
      type: 'message.delta',
      kind: 'text',
      text: 'terminal said ok',
    })
  })
})

describe('a turn the agent refuses', () => {
  it('ends a turn the agent refuses with the reason it gives, and takes the next prompt', async () => {
    expect.hasAssertions()
    const providerConfig = customOf('refuse-prompt')
    const session = await sessionOf({ workspace: { path: workspaceOf() }, providerConfig })
    const refused = await prompted(session, 'Create src/hello.ts')
    expect(refused.slice(-3)).toStrictEqual([
      { type: 'message.completed', role: 'assistant', content: [], text: 'hello; api key absent' },
      {
        type: 'session.warning',
        kind: 'turn_error',
        message: 'Internal error: the model is overloaded for nobody',
      },
      { type: TURN_END, stopReason: 'error', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
    await expect(prompted(session, 'Again')).resolves.toContainEqual({ type: 'turn.started' })
  })

  it('ends a turn whose agent lost its login with the login to perform', async () => {
    expect.hasAssertions()
    const providerConfig = customOf('auth-lapsed', { loginHint: 'fake-agent login' })
    const session = await sessionOf({ workspace: { path: workspaceOf() }, providerConfig })
    await expect(prompted(session, 'Go on')).resolves.toContainEqual({
      type: 'session.warning',
      kind: 'turn_error',
      message: 'Authentication required; log in with: fake-agent login',
    })
  })
})
