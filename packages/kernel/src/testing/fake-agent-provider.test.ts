import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentSession, CreateSessionRequest } from '@bytebureau/plugin-api'
import type { AgentEvent } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import { kernelLogger } from '../logging/logging.js'
import { FakeAgentProvider } from './fake-agent-provider.js'
import { tempDir } from './temp-repo.js'

const provider = new FakeAgentProvider()

const employee: CreateSessionRequest['employee'] = {
  id: 'developer',
  name: 'Developer',
  provider: 'fake',
  model: 'm',
  effort: null,
  systemPrompt: '',
  tools: { allow: [], deny: [] },
  permissionMode: 'supervised',
  skills: [],
  appearance: {},
}

const ASKED = 'ask.requested'
const ASK_ID = 'fake-ask-session-1'
const SLOW = { BYTEBUREAU_FAKE_SCRIPT: 'slow' }

const openSession = async (
  workspace: string,
  env: Readonly<Record<string, string>> = {},
): Promise<AgentSession> => {
  const session = await provider.createSession({
    sessionId: 'session-1',
    workspace: { path: workspace },
    employee,
    profile: { id: 'default', providerId: 'fake', kind: 'login' },
    env,
    signal: new AbortController().signal,
    logger: kernelLogger(['bb', 'test']),
  })
  return session
}

// Reads the events of a session up to the first one of the given type, that one included
const readUntil = async (
  session: AgentSession,
  type: AgentEvent['type'],
): Promise<AgentEvent[]> => {
  const seen: AgentEvent[] = []
  for await (const event of session.events()) {
    seen.push(event)
    if (event.type === type) {
      break
    }
  }
  return seen
}

const readAll = async (session: AgentSession): Promise<AgentEvent[]> => {
  const seen: AgentEvent[] = []
  for await (const event of session.events()) {
    seen.push(event)
  }
  return seen
}

const typesOf = (events: readonly AgentEvent[]): string[] => events.map((event) => event.type)

// How many options of the first question of the first ask the agent recommends
const recommendedOptions = (events: readonly AgentEvent[]): number => {
  const asked = events.flatMap((event) => (event.type === ASKED ? [event.ask] : []))
  const [question] = asked.flatMap((ask) => ask.questions)
  return question === undefined ? 0 : question.options.filter((option) => option.recommended).length
}

const helloFile = (workspace: string): string => path.join(workspace, 'src', 'hello.ts')

// Runs the hello script up to its question, which is answered as given
const runHello = async (
  session: AgentSession,
  selected: readonly string[],
): Promise<AgentEvent[]> => {
  const running = session.prompt({ text: 'Create src/hello.ts' })
  const events = await readUntil(session, ASKED)
  await session.answer(ASK_ID, { selected })
  await running
  return events
}

describe(FakeAgentProvider, () => {
  it('is logged in, named fake and able to ask, interrupt and report usage', async () => {
    expect.hasAssertions()
    await expect(provider.authStatus()).resolves.toStrictEqual({ state: 'loggedIn' })
    expect(provider.id).toBe('fake')
    expect(provider.capabilities).toMatchObject({ askUser: true, interrupt: true, usage: true })
  })

  it('starts a session without an external reference', async () => {
    expect.hasAssertions()
    const session = await openSession(tempDir('bb-fake-'))
    expect(session.externalRef).toBeNull()
    await session.close()
  })
})

describe('the hello script', () => {
  it('asks one question with one recommended option and writes src/hello.ts as answered', async () => {
    expect.hasAssertions()
    const workspace = tempDir('bb-fake-')
    const session = await openSession(workspace)
    const events = await runHello(session, ['yes'])
    expect(recommendedOptions(events)).toBe(1)
    expect(readFileSync(helloFile(workspace), 'utf8')).toBe(
      "export function hello(): string {\n  return 'hello'\n}\n",
    )
    await session.close()
  })

  it('writes a default export when that option is answered', async () => {
    expect.hasAssertions()
    const workspace = tempDir('bb-fake-')
    const session = await openSession(workspace)
    await runHello(session, ['default'])
    expect(readFileSync(helloFile(workspace), 'utf8')).toMatch(/^export default function hello/u)
    await session.close()
  })

  it('writes nothing before the question is answered', async () => {
    expect.hasAssertions()
    const workspace = tempDir('bb-fake-')
    const session = await openSession(workspace)
    const running = session.prompt({ text: 'go' })
    await readUntil(session, ASKED)
    expect(existsSync(helloFile(workspace))).toBe(false)
    await session.close()
    await running
  })
})

describe('the hello script events', () => {
  it('opens a turn with a delta and a started tool call before it asks', async () => {
    expect.hasAssertions()
    const session = await openSession(tempDir('bb-fake-'))
    const running = session.prompt({ text: 'go' })
    const events = await readUntil(session, ASKED)
    expect(typesOf(events)).toStrictEqual(['turn.started', 'message.delta', 'tool.started', ASKED])
    await session.close()
    await running
  })

  it('reports the work and ends the turn with its usage once the question is answered', async () => {
    expect.hasAssertions()
    const session = await openSession(tempDir('bb-fake-'))
    const running = session.prompt({ text: 'go' })
    await readUntil(session, ASKED)
    await session.answer(ASK_ID, { selected: ['yes'] })
    await running
    const rest = readAll(session)
    await session.close()
    expect(typesOf(await rest)).toStrictEqual([
      'tool.completed',
      'message.completed',
      'usage.updated',
      'turn.completed',
    ])
  })

  it('stops quietly when the session is closed while it waits for the answer', async () => {
    expect.hasAssertions()
    const workspace = tempDir('bb-fake-')
    const session = await openSession(workspace)
    const running = session.prompt({ text: 'go' })
    await readUntil(session, ASKED)
    await session.close()
    await running
    expect(existsSync(helloFile(workspace))).toBe(false)
    await expect(readAll(session)).resolves.toStrictEqual([])
  })
})

describe('the slow script interrupted', () => {
  it('completes its turn as interrupted when it is interrupted', async () => {
    expect.hasAssertions()
    const session = await openSession(tempDir('bb-fake-'), SLOW)
    const running = session.prompt({ text: 'take your time' })
    await readUntil(session, 'turn.started')
    await session.interrupt()
    await running
    await session.close()
    await expect(readAll(session)).resolves.toStrictEqual([
      {
        type: 'turn.completed',
        stopReason: 'interrupted',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ])
  })

  it('does not report an interruption when no turn is running', async () => {
    expect.hasAssertions()
    const session = await openSession(tempDir('bb-fake-'), SLOW)
    await session.interrupt()
    await session.close()
    await expect(readAll(session)).resolves.toStrictEqual([])
  })
})

describe('the slow script closed', () => {
  it('settles the pending prompt and clears its timer when it is closed', async () => {
    expect.hasAssertions()
    const session = await openSession(tempDir('bb-fake-'), SLOW)
    const running = session.prompt({ text: 'take your time' })
    await readUntil(session, 'turn.started')
    await session.close()
    await expect(running).resolves.toBeUndefined()
  })

  it('runs nothing and keeps no timer when it is prompted after it was closed', async () => {
    expect.hasAssertions()
    const session = await openSession(tempDir('bb-fake-'), SLOW)
    await session.close()
    await expect(session.prompt({ text: 'too late' })).resolves.toBeUndefined()
    await expect(readAll(session)).resolves.toStrictEqual([])
  })

  it('falls back to the hello script for any other value of the variable', async () => {
    expect.hasAssertions()
    const session = await openSession(tempDir('bb-fake-'), { BYTEBUREAU_FAKE_SCRIPT: 'other' })
    const running = session.prompt({ text: 'go' })
    const events = await readUntil(session, ASKED)
    expect(typesOf(events)).toContain(ASKED)
    await session.close()
    await running
  })
})
