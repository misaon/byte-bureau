import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Readable } from 'node:stream'
import type { Logger, ProcessSpawner } from '@bytebureau/plugin-api'
import type { Preset } from './presets.js'
import { cutRedacted } from './redaction.js'
import { withinLimit } from './within-limit.js'

// The spawn of node:child_process as the adapter calls it, with the three pipes it needs
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams

// What a provider is given: the spawn of its agents, the process port its terminals run on, its logger
export interface AcpDeps {
  readonly spawn: SpawnFn
  readonly process: ProcessSpawner
  readonly logger: Logger
  // How long an agent started again for a prompt may take to open its session; 60 s when not given
  readonly startLimitMs?: number | undefined
}

export interface Exit {
  readonly code: number | null
  readonly signal: string | null
}

export interface AgentProcess {
  readonly child: ChildProcessWithoutNullStreams
  // Settles once the agent has ended and what it wrote to stderr before is read, a quarter of a second at most
  readonly exited: Promise<Exit>
  readonly recentStderr: () => readonly string[]
}

const STDERR_LINES = 50
// A line is kept to its first 2000 characters, so a progress bar that never ends its line holds no more
const LINE_LIMIT = 2000
const STDERR_GRACE_MS = 250

// The last lines of stderr, kept for the message of a crash and never logged; a secret is redacted as a line comes in
const keepLines = (stderr: Readable, lines: string[], secrets: readonly string[]): void => {
  let partial = ''
  const keep = (line: string): void => {
    const told = cutRedacted(line, LINE_LIMIT, secrets).trimEnd()
    if (told.trim() !== '') {
      lines.push(told)
      lines.splice(0, Math.max(0, lines.length - STDERR_LINES))
    }
  }
  stderr.setEncoding('utf8')
  stderr.on('data', (chunk: string) => {
    const parts = `${partial}${chunk}`.split('\n')
    // One character past the limit tells keep() that the line ran on past the cut
    partial = (parts.pop() ?? '').slice(0, LINE_LIMIT + 1)
    for (const line of parts) {
      keep(line)
    }
  })
  stderr.on('end', () => {
    keep(partial)
  })
  stderr.on('error', () => {
    // What the agent wrote before is all there is
  })
}

const closedOf = async (stream: Readable): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<null>()
  stream.once('close', () => {
    resolve(null)
  })
  await promise
}

const exitedOf = async (child: ChildProcessWithoutNullStreams): Promise<Exit> => {
  const stderrClosed = closedOf(child.stderr)
  const { promise, resolve } = Promise.withResolvers<Exit>()
  child.once('exit', (code, signal) => {
    resolve({ code, signal })
  })
  const exit = await promise
  await withinLimit(stderrClosed, STDERR_GRACE_MS)
  return exit
}

// A command that is not there is told with what to install and how to log in; any other failure as it is
const startedOf = async (child: ChildProcessWithoutNullStreams, preset: Preset): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<null>()
  child.once('spawn', () => {
    resolve(null)
  })
  child.on('error', (error: NodeJS.ErrnoException) => {
    const missing = `${preset.command} is not installed; ${preset.installHint}; then log in with: ${preset.loginHint}`
    reject(error.code === 'ENOENT' ? new Error(missing) : error)
  })
  await promise
}

// The agent of a preset, started in the workspace with the environment the session gives it and what the preset adds
// A pipe to an agent that has gone fails; its exit tells that, so the pipe's error is not one of its own
export const spawnAgent = async (
  spawn: SpawnFn,
  preset: Preset,
  options: {
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly secrets: readonly string[]
  },
): Promise<AgentProcess> => {
  if (!existsSync(options.cwd)) {
    throw new Error(`the workspace ${options.cwd} does not exist`)
  }
  // A group of its own, so what the agent starts is signalled with it
  const child = spawn(preset.command, [...preset.args], {
    cwd: options.cwd,
    env: { ...options.env, ...preset.env },
    detached: true,
    // No console window of its own on Windows; ignored elsewhere
    windowsHide: true,
  })
  const lines: string[] = []
  keepLines(child.stderr, lines, options.secrets)
  child.stdin.on('error', () => {
    // The exit of the agent tells it
  })
  const exited = exitedOf(child)
  await startedOf(child, preset)
  return { child, exited, recentStderr: () => [...lines] }
}

// How the agent ended, with its last word on stderr
export const endingOf = (agent: AgentProcess, exit: Exit): string => {
  const how =
    exit.code === null
      ? `was killed by ${exit.signal ?? 'a signal'}`
      : `exited with code ${exit.code}`
  const last = agent.recentStderr().at(-1)
  return `the agent ${how}${last === undefined ? '' : `: ${last}`}`
}
