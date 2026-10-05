import { Readable, Writable } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ClientApp,
  type ClientCapabilities,
  type ClientConnection,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type InitializeResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import type { AgentProcess } from './process.js'

// What the client serves the agent: the updates it reports, the permissions it asks for, its files and its terminals
export interface ClientHandlers {
  readonly sessionUpdate: (notification: SessionNotification) => void
  readonly requestPermission: (
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionResponse>
  readonly readTextFile: (params: ReadTextFileRequest) => Promise<ReadTextFileResponse>
  readonly writeTextFile: (params: WriteTextFileRequest) => Promise<WriteTextFileResponse>
  readonly createTerminal: (params: CreateTerminalRequest) => Promise<CreateTerminalResponse>
  readonly terminalOutput: (params: TerminalOutputRequest) => TerminalOutputResponse
  readonly waitForTerminalExit: (
    params: WaitForTerminalExitRequest,
  ) => Promise<WaitForTerminalExitResponse>
  readonly killTerminal: (params: KillTerminalRequest) => KillTerminalResponse
  readonly releaseTerminal: (params: ReleaseTerminalRequest) => ReleaseTerminalResponse
}

export interface Connected {
  readonly connection: ClientConnection
  readonly initialized: InitializeResponse
}

// An agent that serves the session: its process, its connection and its ACP session
export interface Running {
  readonly process: AgentProcess
  readonly connection: ClientConnection
  readonly sessionId: string
  // Set once its death is told
  gone: boolean
}

const CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
}

// The SDK handles an update a few microtasks after it reads it, and an answer at once; a turn of the event loop lets the updates sent before an answer through
export const settled = async (): Promise<void> => {
  await nextTurn()
}

// What an error of the agent says, with the details an internal error carries
export const reasonOf = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const { data } = error instanceof RequestError ? error : { data: undefined }
  const details =
    typeof data === 'object' && data !== null && 'details' in data ? data.details : data
  return typeof details === 'string' && details !== ''
    ? `${error.message}: ${details}`
    : error.message
}

// Updates are registered first: an update is told before anything the agent asks after it
const appOf = (handlers: ClientHandlers): ClientApp =>
  client({ name: 'bytebureau' })
    .onNotification('session/update', ({ params }) => {
      handlers.sessionUpdate(params)
    })
    .onRequest('session/request_permission', async ({ params, signal }) => {
      const response = await handlers.requestPermission(params, signal)
      return response
    })
    .onRequest('fs/read_text_file', async ({ params }) => {
      const response = await handlers.readTextFile(params)
      return response
    })
    .onRequest('fs/write_text_file', async ({ params }) => {
      const response = await handlers.writeTextFile(params)
      return response
    })
    .onRequest('terminal/create', async ({ params }) => {
      const response = await handlers.createTerminal(params)
      return response
    })
    .onRequest('terminal/output', ({ params }) => handlers.terminalOutput(params))
    .onRequest('terminal/wait_for_exit', async ({ params }) => {
      const response = await handlers.waitForTerminalExit(params)
      return response
    })
    .onRequest('terminal/kill', ({ params }) => handlers.killTerminal(params))
    .onRequest('terminal/release', ({ params }) => handlers.releaseTerminal(params))

// The agent's stdio as ACP v1: the handlers serve the agent's requests, the connection carries ours
export const connectAgent = async (
  agent: AgentProcess,
  handlers: ClientHandlers,
): Promise<Connected> => {
  const stream = ndJsonStream(Writable.toWeb(agent.child.stdin), Readable.toWeb(agent.child.stdout))
  const connection = appOf(handlers).connect(stream)
  const initialized = await connection.agent.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: CLIENT_CAPABILITIES,
  })
  if (initialized.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(
      `the agent speaks ACP v${initialized.protocolVersion}; ByteBureau speaks ACP v${PROTOCOL_VERSION}`,
    )
  }
  return { connection, initialized }
}

// A session/load when the session to resume is known and the agent can load one, else a session/new
export const openSession = async (
  { connection, initialized }: Connected,
  cwd: string,
  resume: string | undefined,
): Promise<string> => {
  const capabilities = initialized.agentCapabilities
  const canLoad = capabilities !== undefined && capabilities.loadSession === true
  if (resume !== undefined && canLoad) {
    await connection.agent.request('session/load', { sessionId: resume, cwd, mcpServers: [] })
    return resume
  }
  const { sessionId } = await connection.agent.request('session/new', { cwd, mcpServers: [] })
  return sessionId
}
