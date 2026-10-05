// What a turn of the fake ACP agent does through its client, script by script; fake-acp-agent.ts serves the protocol, picks the script and holds those that end the process
import { spawn } from 'node:child_process'
import path from 'node:path'
import type {
  AgentContext,
  PromptResponse,
  SessionUpdate,
  ToolCall,
} from '@agentclientprotocol/sdk'

export interface Turn {
  readonly client: AgentContext
  readonly sessionId: string
}

export const API_KEY = process.env['FAKE_ACP_API_KEY']
const HELLO = "export function hello(): string {\n  return 'hello'\n}\n"
// A command that prints ok and the names of the variables of its environment that look like a key or a token
const LIST_KEYS =
  'console.log(["ok", ...Object.keys(process.env).filter((name) => /KEY|TOKEN/.test(name))].join(" "))'
export const END_TURN: PromptResponse = { stopReason: 'end_turn' }
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
export const state = { cwd: '', cancelled: false, cancel: Promise.withResolvers<null>() }

export const update = async (
  { client, sessionId }: Turn,
  payload: SessionUpdate,
): Promise<void> => {
  await client.notify('session/update', { sessionId, update: payload })
}

export const say = async (turn: Turn, text: string): Promise<void> => {
  await update(turn, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const allowed = async ({ client, sessionId }: Turn): Promise<boolean> => {
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

const failedTool = async (turn: Turn, toolCallId: string, rawOutput: string): Promise<void> => {
  await update(turn, { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed', rawOutput })
}

// Asks to write src/hello.ts, and writes it only when allowed; a cancelled turn ends as cancelled
export const hello = async (turn: Turn): Promise<PromptResponse> => {
  await update(turn, { sessionUpdate: 'tool_call', ...WRITE })
  const answered = await allowed(turn)
  const refusal = state.cancelled ? 'cancelled' : 'denied'
  await (answered ? write(turn) : failedTool(turn, WRITE.toolCallId, refusal))
  return state.cancelled ? { stopReason: 'cancelled' } : END_TURN
}

// Runs until the client cancels the prompt
export const slow = async (): Promise<PromptResponse> => {
  await state.cancel.promise
  return { stopReason: 'cancelled' }
}

// Reads a file one level above the workspace and tells what the client answered
export const escape = async (turn: Turn): Promise<PromptResponse> => {
  const target = `${state.cwd}/../outside.txt`
  await update(turn, { sessionUpdate: 'tool_call', ...READ_OUTSIDE, rawInput: { path: target } })
  try {
    const { content } = await turn.client.request('fs/read_text_file', {
      sessionId: turn.sessionId,
      path: target,
    })
    await say(turn, `outside.txt says ${content}`)
  } catch (error) {
    await failedTool(turn, READ_OUTSIDE.toolCallId, messageOf(error))
  }
  return END_TURN
}

// Runs a command in a terminal of the client and says what it printed
export const terminal = async (turn: Turn): Promise<PromptResponse> => {
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

// Answers the prompt with the error once it has said hello
export const failing = (failure: Error) => async (): Promise<PromptResponse> => {
  await Promise.resolve()
  throw failure
}

// Starts a process of its own and a terminal of the client, both running until killed, then runs until cancelled
export const children = async (turn: Turn): Promise<PromptResponse> => {
  const forever = ['-e', 'setInterval(() => {}, 1000)']
  const own = spawn(process.execPath, forever, { stdio: 'ignore' })
  const { terminalId } = await turn.client.request('terminal/create', {
    sessionId: turn.sessionId,
    command: process.execPath,
    args: forever,
  })
  await say(turn, `children ${String(own.pid)} ${terminalId}`)
  const ended = await slow()
  return ended
}
