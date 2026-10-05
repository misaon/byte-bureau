#!/usr/bin/env node
// An ACP agent for the tests, run as `node|bun fake-acp-agent.ts`; BYTEBUREAU_FAKE_ACP_SCRIPT picks what it does (hello when unset), some misbehaving as real agents can
// The scripts that end the process are here, with the process; the others are in fake-acp-scripts.ts, imported by its .ts name, as Node runs both files unbuilt
import { Readable, Writable } from 'node:stream'
import {
  agent,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type InitializeResponse,
  type PromptResponse,
} from '@agentclientprotocol/sdk'
import {
  allowed,
  API_KEY,
  children,
  END_TURN,
  escape,
  failing,
  hello,
  say,
  slow,
  state,
  terminal,
  update,
  type Turn,
} from './fake-acp-scripts.ts'

export type FakeScript =
  | 'hello'
  | 'slow'
  | 'crash-mid-turn'
  | 'crash-idle'
  | 'escape'
  | 'terminal'
  | 'refuse-prompt'
  | 'auth-required'
  | 'protocol-v2'
  | 'load-fails'
  | 'no-load'
  | 'children'
  | 'quick-exit'
  | 'auth-lapsed'
  | 'ask-again'

const SCRIPT = process.env['BYTEBUREAU_FAKE_ACP_SCRIPT'] ?? 'hello'
const INITIALIZED: InitializeResponse = {
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
  },
  authMethods: [],
}

// The last word goes to stderr before the agent dies, as a real agent's would
const die = (code: number, lastWord: string): void => {
  process.stderr.write(`${lastWord}\n`, () => {
    process.exit(code)
  })
}

// Dies in the middle of the turn; its last word names the key it was given, which the client must not repeat
const crashMidTurn = async (): Promise<PromptResponse> => {
  die(1, `the fake agent crashed mid-turn holding ${API_KEY ?? 'no key'}`)
  const never = await Promise.withResolvers<PromptResponse>().promise
  return never
}

// Answers and exits at once, its answer and its exit reaching the client together
const quickExit = async (): Promise<PromptResponse> => {
  setImmediate(() => {
    die(0, 'the fake agent answered and left')
  })
  await Promise.resolve()
  return END_TURN
}

// Holds on through a SIGINT, asks again once its ask is cancelled, and answers and leaves once that one is answered
const askAgain = async (turn: Turn): Promise<PromptResponse> => {
  process.on('SIGINT', () => {
    state.cancelled = true
  })
  await allowed(turn)
  await allowed(turn)
  return quickExit()
}

// Ends the turn as hello does, then dies while idle
const crashIdle = async (turn: Turn): Promise<PromptResponse> => {
  const ended = await hello(turn)
  setTimeout(() => {
    die(0, 'the fake agent exited idle')
  }, 100)
  return ended
}

const SCRIPTS: Readonly<Record<FakeScript, (turn: Turn) => Promise<PromptResponse>>> = {
  hello,
  slow,
  'crash-mid-turn': crashMidTurn,
  'crash-idle': crashIdle,
  escape,
  terminal,
  // A model that failed, its error naming the key the agent was given
  'refuse-prompt': failing(new Error(`the model is overloaded for ${API_KEY ?? 'nobody'}`)),
  'auth-required': hello,
  'protocol-v2': hello,
  'load-fails': hello,
  'no-load': hello,
  children,
  'quick-exit': quickExit,
  'ask-again': askAgain,
  // A login lost by the time of the prompt
  'auth-lapsed': failing(RequestError.authRequired()),
}

const isScript = (name: string): name is FakeScript => Object.hasOwn(SCRIPTS, name)

// Every script thinks and says hello first, telling whether the key reached it, never its value
const prompt = async (turn: Turn): Promise<PromptResponse> => {
  state.cancelled = false
  state.cancel = Promise.withResolvers<null>()
  await update(turn, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking' },
  })
  await say(turn, `hello; api key ${API_KEY === undefined ? 'absent' : 'present'}`)
  const response = await SCRIPTS[isScript(SCRIPT) ? SCRIPT : 'hello'](turn)
  return response
}

// What the agent says of itself: another ACP for protocol-v2, no session loading for no-load
const initializedFor = (script: string): InitializeResponse => {
  if (script === 'protocol-v2') {
    return { ...INITIALIZED, protocolVersion: 2 }
  }
  const capabilities = { ...INITIALIZED.agentCapabilities, loadSession: script !== 'no-load' }
  return { ...INITIALIZED, agentCapabilities: capabilities }
}

// An agent that loads a session streams its history back first, as ACP has it
const fake = agent({ name: 'fake-acp-agent' })
  .onRequest('initialize', () => initializedFor(SCRIPT))
  .onRequest('authenticate', () => ({}))
  .onRequest('session/new', ({ params }) => {
    if (SCRIPT === 'auth-required') {
      throw RequestError.authRequired({ details: `no login for ${API_KEY ?? 'nobody'}` })
    }
    state.cwd = params.cwd
    return { sessionId: 'fake-acp-1' }
  })
  .onRequest('session/load', async ({ params, client }) => {
    if (SCRIPT === 'load-fails') {
      throw RequestError.resourceNotFound(params.sessionId)
    }
    state.cwd = params.cwd
    await say({ client, sessionId: params.sessionId }, 'from the loaded history')
    return {}
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const response = await prompt({ client, sessionId: params.sessionId })
    return response
  })
  .onNotification('session/cancel', () => {
    state.cancelled = true
    state.cancel.resolve(null)
  })

// The agent ends with its client: once stdin closes, nobody is left to serve
const connection = fake.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
)
await connection.closed
process.exit(0)
