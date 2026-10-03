import {
  definePlugin,
  type AgentProvider,
  type AgentSession,
  type CreateSessionRequest,
  type ExternalSessionRef,
  type Hooks,
  type Plugin,
} from '@bytebureau/plugin-api'
import type { AgentEvent, AskAnswer, PromptInput } from '@bytebureau/protocol'
import { Latch } from 'effect'
import { manifestOf, providerOf } from '../plugins/plugin-fixtures.js'
import { EventQueue } from './event-queue.js'

// An agent session a test drives: the test pushes the events, and sees what the kernel asked of it
export interface ScriptedSession extends AgentSession {
  readonly request: CreateSessionRequest
  readonly queue: EventQueue
  readonly prompts: PromptInput[]
  readonly answers: { readonly askId: string; readonly answer: AskAnswer }[]
  // Each is opened once the kernel has made the call, however it is answered
  readonly calls: {
    readonly interrupt: Latch.Latch
    readonly close: Latch.Latch
    readonly answer: Latch.Latch
  }
  externalRef: ExternalSessionRef | null
  interrupts: number
  closed: boolean
}

export interface Behaviour {
  // The reference its sessions report
  readonly externalRef?: ExternalSessionRef | undefined
  // Makes the provider refuse to start a session
  readonly startFailure?: Error | undefined
  // What the session does when it is prompted; a rejection is the agent not taking the prompt
  readonly onPrompt?: ((session: ScriptedSession, input: PromptInput) => Promise<void>) | undefined
  // What the session does when it is told an answer; a rejection is the agent not taking it
  readonly onAnswer?: ((session: ScriptedSession) => Promise<void>) | undefined
  // Makes the stream of events of its sessions fail instead of delivering them, or fail to be given at all
  readonly eventsFailure?: Error | undefined
  readonly eventsThrow?: Error | undefined
  // Gives the events as an async generator, which is the usual shape of them: its return waits for the read in progress
  readonly generator?: boolean | undefined
  // Holds the start of a session until the test releases it
  readonly holdsStart?: boolean | undefined
  // The calls its sessions never answer; a close that never answers does not end the events either
  readonly hangs?: readonly ('interrupt' | 'close' | 'answer')[] | undefined
}

export interface Scripted {
  readonly provider: AgentProvider
  readonly sessions: readonly ScriptedSession[]
  // Every request to start a session, those that never finished included
  readonly requests: readonly CreateSessionRequest[]
  // Opened when the kernel first asks the provider for a session, and when the first one exists
  readonly asked: Latch.Latch
  readonly created: Latch.Latch
  // Lets the starts that are held go on
  readonly release: () => void
}

const rejected = async (failure: Error): Promise<never> => {
  await Promise.resolve()
  throw failure
}

// A stream of events that fails as soon as it is read
const failing = (failure: Error): AsyncIterable<AgentEvent> => ({
  [Symbol.asyncIterator]: () => ({
    next: async () => {
      const result = await rejected(failure)
      return result
    },
  }),
})

// A call that is made and never answered, when the behaviour says so
const stall = async (
  behaviour: Behaviour,
  call: 'interrupt' | 'close' | 'answer',
): Promise<void> => {
  if (behaviour.hangs !== undefined && behaviour.hangs.includes(call)) {
    await Promise.withResolvers<null>().promise
  }
}

// The events of a queue as an async generator
async function* generated(queue: EventQueue): AsyncGenerator<AgentEvent> {
  for await (const event of queue) {
    yield event
  }
}

// The events of a session as the behaviour has them: delivered, failing when read, or not given at all
const eventsOf = (queue: EventQueue, behaviour: Behaviour): AsyncIterable<AgentEvent> => {
  if (behaviour.eventsThrow !== undefined) {
    throw behaviour.eventsThrow
  }
  if (behaviour.eventsFailure !== undefined) {
    return failing(behaviour.eventsFailure)
  }
  return behaviour.generator === true ? generated(queue) : queue
}

const sessionOf = (request: CreateSessionRequest, behaviour: Behaviour): ScriptedSession => {
  const queue = new EventQueue()
  const calls = {
    interrupt: Latch.makeUnsafe(),
    close: Latch.makeUnsafe(),
    answer: Latch.makeUnsafe(),
  }
  const session: ScriptedSession = {
    request,
    queue,
    prompts: [],
    answers: [],
    calls,
    externalRef: behaviour.externalRef ?? null,
    interrupts: 0,
    closed: false,
    prompt: async (input) => {
      session.prompts.push(input)
      if (behaviour.onPrompt !== undefined) {
        await behaviour.onPrompt(session, input)
      }
    },
    interrupt: async () => {
      session.interrupts += 1
      Latch.openUnsafe(calls.interrupt)
      await stall(behaviour, 'interrupt')
    },
    answer: async (askId, answer) => {
      session.answers.push({ askId, answer })
      Latch.openUnsafe(calls.answer)
      await stall(behaviour, 'answer')
      if (behaviour.onAnswer !== undefined) {
        await behaviour.onAnswer(session)
      }
    },
    events: () => eventsOf(queue, behaviour),
    close: async () => {
      session.closed = true
      Latch.openUnsafe(calls.close)
      await stall(behaviour, 'close')
      queue.end()
    },
  }
  return session
}

// What a start waits for before it goes on: a refusal, or the release of the test
const beforeStart = async (behaviour: Behaviour, released: Promise<null>): Promise<void> => {
  if (behaviour.startFailure !== undefined) {
    throw behaviour.startFailure
  }
  if (behaviour.holdsStart === true) {
    await released
  }
}

// A provider whose sessions do nothing by themselves: what they do is what the test pushes into them
export const scriptedProvider = (id: string, behaviour: Behaviour = {}): Scripted => {
  const sessions: ScriptedSession[] = []
  const requests: CreateSessionRequest[] = []
  const asked = Latch.makeUnsafe()
  const created = Latch.makeUnsafe()
  const gate = Promise.withResolvers<null>()
  const provider: AgentProvider = {
    ...providerOf(id),
    createSession: async (request) => {
      requests.push(request)
      Latch.openUnsafe(asked)
      await beforeStart(behaviour, gate.promise)
      const session = sessionOf(request, behaviour)
      sessions.push(session)
      Latch.openUnsafe(created)
      return session
    },
  }
  return {
    provider,
    sessions,
    requests,
    asked,
    created,
    release: () => {
      gate.resolve(null)
    },
  }
}

// The plugin that offers the provider, with the hooks a test wants beside it
export const scriptedPlugin = (scripted: Scripted, hooks: Partial<Hooks> = {}): Plugin =>
  definePlugin({
    manifest: manifestOf(`scripted-${scripted.provider.id}`, {
      contributes: { agentProviders: [scripted.provider.id] },
    }),
    setup: () => ({ agentProviders: [scripted.provider], hooks }),
  })

// The session a test drives, which exists once the kernel has started it; a session that was resumed has had several, the last is the one
export const sessionOfKernel = (scripted: Scripted, sessionId: string): ScriptedSession => {
  const found = scripted.sessions.findLast((candidate) => candidate.request.sessionId === sessionId)
  if (found === undefined) {
    throw new Error(`the scripted provider has no session ${sessionId}`)
  }
  return found
}
