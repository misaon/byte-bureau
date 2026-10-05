import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  AgentEvent,
  AgentSession,
  AskAnswer,
  CreateSessionRequest,
} from '@bytebureau/plugin-api'
import { describe, expect, it } from 'vitest'
import { AcpAgentProvider } from './provider.js'
import type { FakeScript } from './testing/fake-acp-agent.js'
import { CANARY_KEY, sessionRequest, tempDir } from './testing/requests.js'
import { fakeAgentCommand } from './testing/run-fake.js'
import { harness, started, until, type Harness } from './testing/session-harness.js'

const TURN_END = 'turn.completed'
const ALLOW: AskAnswer = { selected: ['allow'] }
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

// A workspace with a parent of its own, so a file above it is the test's too
const workspaceOf = (): string => {
  const workspace = path.join(tempDir('bb-acp-ws-'), 'ws')
  mkdirSync(workspace)
  return workspace
}

// The providers["acp:custom"] section that runs the fake agent
const customOf = (
  script: FakeScript,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({ ...fakeAgentCommand(script), ...extra })

// A session of the custom provider over the fake agent, closed when the test ends
const sessionOf = async (
  request: Partial<CreateSessionRequest>,
  run: Harness = harness(),
): Promise<AgentSession> => {
  const provider = new AcpAgentProvider('custom', run.deps)
  const session = await started(provider, sessionRequest(request))
  return session
}

// The events of a prompt up to the first of the type, its asks allowed as they come
const prompted = async (
  session: AgentSession,
  text: string,
  last: AgentEvent['type'] = TURN_END,
): Promise<AgentEvent[]> => {
  const reading = until(session, last, ALLOW)
  await session.prompt({ text })
  const seen = await reading
  return seen
}

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

describe('the agent an ACP session starts', () => {
  it('runs in the workspace with the environment of the request, the preset and the login directory', async () => {
    expect.hasAssertions()
    const workspace = workspaceOf()
    const run = harness()
    const profile = {
      id: 'acp:custom/work',
      providerId: 'acp:custom',
      kind: 'login',
      configDir: '/h/p',
    } as const
    const providerConfig = customOf('hello', { configDirEnv: 'FAKE_ACP_HOME' })
    await sessionOf({ workspace: { path: workspace }, providerConfig, profile }, run)
    const env = {
      ...sessionRequest().env,
      BYTEBUREAU_FAKE_ACP_SCRIPT: 'hello',
      FAKE_ACP_HOME: '/h/p',
    }
    expect(run.spawned.map(({ options }) => [options.cwd, options.env])).toStrictEqual([
      [workspace, env],
    ])
  })

  it('loads the session a resume names when the agent can, and starts a new one for a resume of another provider', async () => {
    expect.hasAssertions()
    const base = { workspace: { path: workspaceOf() }, providerConfig: customOf('hello') }
    const resume = { providerId: 'acp:custom', ref: 'fake-acp-earlier' }
    const loaded = await sessionOf({ ...base, resume })
    expect(loaded.externalRef).toStrictEqual(resume)
    const [first] = await prompted(loaded, 'Go on')
    expect(first).toStrictEqual({ type: 'turn.started' })
    const fresh = await sessionOf({
      ...base,
      resume: { providerId: 'claude', ref: 'session-0001' },
    })
    expect(fresh.externalRef).toStrictEqual({ providerId: 'acp:custom', ref: 'fake-acp-1' })
  })
})

describe('the key of an ACP session', () => {
  it('is redacted from an error the agent answers a prompt with', async () => {
    expect.hasAssertions()
    const run = harness()
    const providerConfig = customOf('refuse-prompt', { apiKeyEnv: 'FAKE_ACP_API_KEY' })
    const env = { PATH: '/usr/bin:/bin', FAKE_ACP_API_KEY: CANARY_KEY }
    const session = await sessionOf(
      { workspace: { path: workspaceOf() }, providerConfig, env },
      run,
    )
    const told = JSON.stringify([await prompted(session, 'Create src/hello.ts'), run.logged])
    expect(told).toContain('Internal error: the model is overloaded for [redacted]')
    expect(told).not.toContain(CANARY_KEY)
  })

  it('hands the API key to the agent alone: no event or log line holds it', async () => {
    expect.hasAssertions()
    const run = harness()
    const providerConfig = customOf('crash-mid-turn', { apiKeyEnv: 'FAKE_ACP_API_KEY' })
    const env = { PATH: '/usr/bin:/bin', FAKE_ACP_API_KEY: CANARY_KEY }
    const session = await sessionOf(
      { workspace: { path: workspaceOf() }, providerConfig, env },
      run,
    )
    const told = JSON.stringify([
      await prompted(session, 'Show me the key', 'session.closed'),
      run.logged,
    ])
    expect(told).toContain('hello; api key present')
    expect(told).toContain('the fake agent crashed mid-turn holding [redacted]')
    expect(told).not.toContain(CANARY_KEY)
  })
})
