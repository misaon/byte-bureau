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
import { manifestOf, providerOf } from '../plugins/plugin-fixtures.js'
import { EventQueue } from './event-queue.js'

// An agent session a test drives: the test pushes the events, and sees what the kernel asked of it
export interface ScriptedSession extends AgentSession {
  readonly request: CreateSessionRequest
  readonly queue: EventQueue
  readonly prompts: PromptInput[]
  readonly answers: { readonly askId: string; readonly answer: AskAnswer }[]
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
  // Makes the provider never finish starting a session
  readonly startHangs?: boolean | undefined
  // The calls its sessions never answer
  readonly hangs?: readonly ('interrupt' | 'close' | 'answer')[] | undefined
}

export interface Scripted {
  readonly provider: AgentProvider
  readonly sessions: readonly ScriptedSession[]
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

// The events of a session as the behaviour has them: delivered, failing when read, or not given at all
const eventsOf = (queue: EventQueue, behaviour: Behaviour): AsyncIterable<AgentEvent> => {
  if (behaviour.eventsThrow !== undefined) {
    throw behaviour.eventsThrow
  }
  return behaviour.eventsFailure === undefined ? queue : failing(behaviour.eventsFailure)
}

const sessionOf = (request: CreateSessionRequest, behaviour: Behaviour): ScriptedSession => {
  const queue = new EventQueue()
  const session: ScriptedSession = {
    request,
    queue,
    prompts: [],
    answers: [],
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
      await stall(behaviour, 'interrupt')
    },
    answer: async (askId, answer) => {
      session.answers.push({ askId, answer })
      await stall(behaviour, 'answer')
      if (behaviour.onAnswer !== undefined) {
        await behaviour.onAnswer(session)
      }
    },
    events: () => eventsOf(queue, behaviour),
    close: async () => {
      session.closed = true
      queue.end()
      await stall(behaviour, 'close')
    },
  }
  return session
}

// A provider whose sessions do nothing by themselves: what they do is what the test pushes into them
export const scriptedProvider = (id: string, behaviour: Behaviour = {}): Scripted => {
  const sessions: ScriptedSession[] = []
  const provider: AgentProvider = {
    ...providerOf(id),
    createSession: async (request) => {
      if (behaviour.startFailure !== undefined) {
        throw behaviour.startFailure
      }
      if (behaviour.startHangs === true) {
        await Promise.withResolvers<null>().promise
      }
      const session = sessionOf(request, behaviour)
      sessions.push(session)
      await Promise.resolve()
      return session
    },
  }
  return { provider, sessions }
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
