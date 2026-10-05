import {
  RequestError,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type EnvVariable,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk'
import type { ExecHandle, ProcessSpawner } from '@bytebureau/plugin-api'
import { confined } from './client-fs.js'
import { withinLimit } from './within-limit.js'

type Exit = Awaited<ExecHandle['exited']>

// What a command printed, the newest within the limit; truncated once anything was dropped
interface Output {
  readonly chunks: string[]
  readonly limit: number
  bytes: number
  truncated: boolean
}

interface Terminal {
  readonly handle: ExecHandle
  readonly output: Output
  // Settles once the command has ended and what it printed is read, a second at most after
  readonly done: Promise<Exit>
  readonly exit: () => Exit | undefined
}

const DEFAULT_LIMIT = 1024 * 1024
// An agent may ask for more than the default, never for more than a terminal holds in memory
const MAX_LIMIT = 16 * 1024 * 1024
const OUTPUT_GRACE_MS = 1000
const NOT_STARTED: Exit = { code: null, signal: null }

// A UTF-8 byte that continues a character is 10xxxxxx: 128 to 191
const isContinuation = (byte: number | undefined): boolean =>
  byte !== undefined && byte >= 128 && byte < 192

// The last bytes of a text that fit, cut where a character starts
const tailOf = (text: string, bytes: number): string => {
  const encoded = Buffer.from(text, 'utf8')
  let start = Math.max(encoded.length - bytes, 0)
  while (isContinuation(encoded[start])) {
    start += 1
  }
  return encoded.subarray(start).toString('utf8')
}

// The oldest output goes first once the limit is passed, until nothing is left to drop
const append = (output: Output, text: string): void => {
  output.chunks.push(text)
  output.bytes += Buffer.byteLength(text)
  while (output.bytes > output.limit && output.chunks.length > 0) {
    const [oldest = ''] = output.chunks
    const size = Buffer.byteLength(oldest)
    const kept = tailOf(oldest, Math.max(size - (output.bytes - output.limit), 0))
    output.bytes -= size - Buffer.byteLength(kept)
    output.chunks.splice(0, 1, ...(kept === '' ? [] : [kept]))
    output.truncated = true
  }
}

// Out and err land together, as a terminal shows them
const pump = async (lines: AsyncIterable<string>, output: Output): Promise<void> => {
  try {
    for await (const line of lines) {
      append(output, `${line}\n`)
    }
  } catch {
    // A stream that fails has printed all it will
  }
}

const exitOf = async (handle: ExecHandle): Promise<Exit> => {
  try {
    const exit = await handle.exited
    return exit
  } catch {
    return NOT_STARTED
  }
}

const terminalOf = (handle: ExecHandle, limit: number): Terminal => {
  const output: Output = { chunks: [], limit, bytes: 0, truncated: false }
  const ended: { exit?: Exit } = {}
  const done = async (): Promise<Exit> => {
    const pumped = Promise.all([pump(handle.stdout, output), pump(handle.stderr, output)])
    const exit = await exitOf(handle)
    await withinLimit(pumped, OUTPUT_GRACE_MS)
    ended.exit = exit
    return exit
  }
  return { handle, output, done: done(), exit: () => ended.exit }
}

// A command that still runs is ended; one that has ended is left be
const endTerminal = (terminal: Terminal): void => {
  if (terminal.exit() === undefined) {
    terminal.handle.kill('SIGTERM')
  }
}

// The limit in whole bytes, none below zero and 16 MiB at most; a limit that is not a number is the default
const limitOf = (requested: number | null | undefined): number =>
  typeof requested === 'number' && !Number.isNaN(requested)
    ? Math.min(Math.max(Math.floor(requested), 0), MAX_LIMIT)
    : DEFAULT_LIMIT

const envOf = (env: readonly EnvVariable[] | undefined): Record<string, string> =>
  Object.fromEntries((env ?? []).map(({ name, value }) => [name, value]))

const statusOf = ({ code, signal }: Exit): WaitForTerminalExitResponse => ({
  exitCode: code,
  signal,
})

// The terminals an agent runs commands in: on the process port of the plugin, in the workspace, with the environment of the session
export class Terminals {
  private readonly spawner: ProcessSpawner
  private readonly workspace: string
  private readonly env: Readonly<Record<string, string>>
  private readonly terminals = new Map<string, Terminal>()
  private created = 0
  private closed = false

  public constructor(
    spawner: ProcessSpawner,
    workspace: string,
    env: Readonly<Record<string, string>>,
  ) {
    this.spawner = spawner
    this.workspace = workspace
    this.env = env
  }

  public async create(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    if (this.closed) {
      throw RequestError.invalidRequest(undefined, 'the session is closed')
    }
    const cwd = confined(this.workspace, params.cwd ?? this.workspace)
    const env = { ...this.env, ...envOf(params.env) }
    const args = params.args ?? []
    const handle = await this.spawner.spawn({ command: params.command, args, cwd, env })
    this.created += 1
    const terminalId = `term-${this.created}`
    this.terminals.set(terminalId, terminalOf(handle, limitOf(params.outputByteLimit)))
    return { terminalId }
  }

  public output({ terminalId }: TerminalOutputRequest): TerminalOutputResponse {
    const { output, exit } = this.terminalOf(terminalId)
    const ended = exit()
    const told = { output: output.chunks.join(''), truncated: output.truncated }
    return ended === undefined ? told : { ...told, exitStatus: statusOf(ended) }
  }

  public async waitForExit({
    terminalId,
  }: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const exit = await this.terminalOf(terminalId).done
    return statusOf(exit)
  }

  public kill({ terminalId }: KillTerminalRequest): KillTerminalResponse {
    endTerminal(this.terminalOf(terminalId))
    return {}
  }

  // A released terminal is ended if it still runs, and forgotten
  public release({ terminalId }: ReleaseTerminalRequest): ReleaseTerminalResponse {
    endTerminal(this.terminalOf(terminalId))
    this.terminals.delete(terminalId)
    return {}
  }

  public releaseAll(): void {
    for (const terminal of this.terminals.values()) {
      endTerminal(terminal)
    }
    this.terminals.clear()
  }

  // The terminals of a closed session end, and no other is created
  public close(): void {
    this.closed = true
    this.releaseAll()
  }

  private terminalOf(terminalId: string): Terminal {
    const terminal = this.terminals.get(terminalId)
    if (terminal === undefined) {
      throw RequestError.invalidParams({ terminalId }, `no terminal ${terminalId}`)
    }
    return terminal
  }
}
