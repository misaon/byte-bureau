#!/usr/bin/env node
// An ACP agent for the tests, run as `node|bun fake-acp-agent.ts`; BYTEBUREAU_FAKE_ACP_SCRIPT picks what it does, hello when unset
// The last three scripts misbehave as real agents can: they refuse the prompt, demand a login, or speak another ACP
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  agent,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentContext,
  type InitializeResponse,
  type PromptResponse,
  type SessionUpdate,
  type ToolCall,
} from '@agentclientprotocol/sdk'

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

interface Turn {
  readonly client: AgentContext
  readonly sessionId: string
}

const SCRIPT = process.env['BYTEBUREAU_FAKE_ACP_SCRIPT'] ?? 'hello'
const API_KEY = process.env['FAKE_ACP_API_KEY']
const HELLO = "export function hello(): string {\n  return 'hello'\n}\n"
// A command that prints ok and the names of the variables of its environment that look like a key or a token
const LIST_KEYS =
  'console.log(["ok", ...Object.keys(process.env).filter((name) => /KEY|TOKEN/.test(name))].join(" "))'
const END_TURN: PromptResponse = { stopReason: 'end_turn' }
const INITIALIZED: InitializeResponse = {
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
  },
  authMethods: [],
}
const WRITE: ToolCall = {
  toolCallId: 'call-1',
  title: 'Write src/hello.ts',
  kind: 'edit',
  status: 'pending',
  rawInput: { path: 'src/hello.ts' },
}
const READ_OUTSIDE: ToolCall = {
  toolCallId: 'call-2',
  title: 'Read ../outside.txt',
  kind: 'read',
  status: 'pending',
}

// The workspace the client named, and the cancel of the running prompt
const state = { cwd: '', cancel: Promise.withResolvers<null>() }

const update = async ({ client, sessionId }: Turn, payload: SessionUpdate): Promise<void> => {
  await client.notify('session/update', { sessionId, update: payload })
}

const say = async (turn: Turn, text: string): Promise<void> => {
  await update(turn, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

// The last word goes to stderr before the agent dies, as a real agent's would
const die = (code: number, lastWord: string): void => {
  process.stderr.write(`${lastWord}\n`, () => {
    process.exit(code)
  })
}

const allowed = async ({ client, sessionId }: Turn): Promise<boolean> => {
  const { outcome } = await client.request('session/request_permission', {
    sessionId,
    toolCall: WRITE,
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  })
  return outcome.outcome === 'selected' && outcome.optionId === 'allow'
}

// Writes src/hello.ts through the client and reports the tool with the usage of the turn
const write = async (turn: Turn): Promise<void> => {
  await turn.client.request('fs/write_text_file', {
    sessionId: turn.sessionId,
    path: path.join(state.cwd, 'src', 'hello.ts'),
    content: HELLO,
  })
  await update(turn, {
    sessionUpdate: 'tool_call_update',
    toolCallId: WRITE.toolCallId,
    status: 'completed',
    rawOutput: 'written',
    _meta: { 'bytebureau.usage': { inputTokens: 7, outputTokens: 3 } },
  })
}

const refused = async (turn: Turn): Promise<void> => {
  await update(turn, {
    sessionUpdate: 'tool_call_update',
    toolCallId: WRITE.toolCallId,
    status: 'failed',
    rawOutput: 'denied',
  })
}

// Asks to write src/hello.ts, and writes it only when allowed
const hello = async (turn: Turn): Promise<PromptResponse> => {
  await update(turn, { sessionUpdate: 'tool_call', ...WRITE })
  await ((await allowed(turn)) ? write(turn) : refused(turn))
  return END_TURN
}

// Runs until the client cancels the prompt
const slow = async (): Promise<PromptResponse> => {
  await state.cancel.promise
  return { stopReason: 'cancelled' }
}

// Reads a file one level above the workspace and tells what the client answered
const escape = async (turn: Turn): Promise<PromptResponse> => {
  const target = `${state.cwd}/../outside.txt`
  await update(turn, { sessionUpdate: 'tool_call', ...READ_OUTSIDE, rawInput: { path: target } })
  try {
    const { content } = await turn.client.request('fs/read_text_file', {
      sessionId: turn.sessionId,
      path: target,
    })
    await say(turn, `outside.txt says ${content}`)
  } catch (error) {
    await update(turn, {
      sessionUpdate: 'tool_call_update',
      toolCallId: READ_OUTSIDE.toolCallId,
      status: 'failed',
      rawOutput: messageOf(error),
    })
  }
  return END_TURN
}

// Runs a command in a terminal of the client and says what it printed
const terminal = async (turn: Turn): Promise<PromptResponse> => {
  const { client, sessionId } = turn
  const { terminalId } = await client.request('terminal/create', {
    sessionId,
    command: process.execPath,
    args: ['-e', LIST_KEYS],
  })
  await client.request('terminal/wait_for_exit', { sessionId, terminalId })
  const { output } = await client.request('terminal/output', { sessionId, terminalId })
  await client.request('terminal/release', { sessionId, terminalId })
  await say(turn, `terminal said ${output.trim()}`)
  return END_TURN
}

// Dies in the middle of the turn; its last word names the key it was given, which the client must not repeat
const crashMidTurn = async (): Promise<PromptResponse> => {
  die(1, `the fake agent crashed mid-turn holding ${API_KEY ?? 'no key'}`)
  const never = await Promise.withResolvers<PromptResponse>().promise
  return never
}

// Answers the prompt with an error once it has said hello, as an agent whose model failed does; the error names the key it was given
const refusePrompt = async (): Promise<PromptResponse> => {
  await Promise.resolve()
  throw new Error(`the model is overloaded for ${API_KEY ?? 'nobody'}`)
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
  'refuse-prompt': refusePrompt,
  'auth-required': hello,
  'protocol-v2': hello,
  'load-fails': hello,
  'no-load': hello,
}

const isScript = (name: string): name is FakeScript => Object.hasOwn(SCRIPTS, name)

// Every script thinks and says hello first, telling whether the key reached it, never its value
const prompt = async (turn: Turn): Promise<PromptResponse> => {
  state.cancel = Promise.withResolvers<null>()
  await update(turn, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking' },
  })
  await say(turn, `hello; api key ${API_KEY === undefined ? 'absent' : 'present'}`)
  const play = SCRIPTS[isScript(SCRIPT) ? SCRIPT : 'hello']
  const response = await play(turn)
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
    state.cancel.resolve(null)
  })

// The agent ends with its client: once stdin closes, nobody is left to serve
const connection = fake.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
)
await connection.closed
process.exit(0)
