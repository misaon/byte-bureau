import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process'
import { statSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { onTestFinished } from 'vitest'
import { testHome } from './temp-repo.js'

const CLI_DIRECTORY = fileURLToPath(new URL('../..', import.meta.url))
const BASE_ENV = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  LANG: 'en_US.UTF-8',
  // The git of a test never reads the configuration of the person who runs the tests
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

// A home that is empty or no directory is refused before any command runs: it could reach the home of the person who runs the tests
function existingHome(home: string): string {
  const stats = home.trim() === '' ? undefined : statSync(home, { throwIfNoEntry: false })
  if (stats === undefined || !stats.isDirectory()) {
    throw new Error(`a CLI of a test runs on an existing home directory, not on "${home}"`)
  }
  return home
}

// A test that names no home for the CLI gets a throwaway one, never that of the person who runs the tests
// Its daemon, should the CLI start one on demand, listens on a free port
export function childEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return {
    ...BASE_ENV,
    ...env,
    BYTEBUREAU_HOME: existingHome(env['BYTEBUREAU_HOME'] ?? testHome()),
  }
}

export interface CliResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

// The signal goes out once the CLI has printed the text: no timing guess about how far the run has got
export interface Interruption {
  readonly signal: NodeJS.Signals
  readonly afterStdout: string
  // The process that gets the signal in place of the CLI, such as the daemon the CLI talks to
  readonly target?: ChildProcess | undefined
}

type Child = ChildProcessByStdio<Writable | null, Readable, Readable>

type Env = Readonly<Record<string, string>>

interface Captured {
  stdout: string
  stderr: string
}

function capture(child: Child, interruption: Interruption | undefined): Captured {
  const captured: Captured = { stdout: '', stderr: '' }
  let signalled = false
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    captured.stdout += chunk
    if (
      interruption !== undefined &&
      !signalled &&
      captured.stdout.includes(interruption.afterStdout)
    ) {
      signalled = true
      const target = interruption.target ?? child
      target.kill(interruption.signal)
    }
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    captured.stderr += chunk
  })
  return captured
}

function ignoreClosedPipe(): void {
  // Nothing to do: the result of the CLI tells what it read
}

// The CLI from source in a Bun process; with input its stdin is a pipe that gives the text and ends, else it has none
function spawnCli(args: readonly string[], env: Env, input?: string): Child {
  const command = ['run', 'src/main.ts', ...args]
  const options = { cwd: CLI_DIRECTORY, env: childEnv(env) }
  if (input === undefined) {
    return spawn('bun', command, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  const child = spawn('bun', command, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  // A CLI that ends before it reads its stdin closes the pipe: what it did not read is no failure of the test
  child.stdin.on('error', ignoreClosedPipe)
  child.stdin.end(input)
  return child
}

// What the CLI printed and its exit code; a process still alive when the test ends is killed
async function ended(child: Child, interruption?: Interruption): Promise<CliResult> {
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  const captured = capture(child, interruption)
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>()
  child.once('error', reject)
  child.once('close', (code) => {
    resolve({ code: code ?? -1, stdout: captured.stdout, stderr: captured.stderr })
  })
  const result = await promise
  return result
}

// Runs the CLI from source in a Bun process, with nothing on its stdin
export async function runCli(
  args: readonly string[],
  env: Env = {},
  interruption?: Interruption,
): Promise<CliResult> {
  const result = await ended(spawnCli(args, env), interruption)
  return result
}

// Runs the CLI with the text on its stdin, as a pipe gives it to a command
export async function runCliWithStdin(
  args: readonly string[],
  env: Env,
  stdin: string,
): Promise<CliResult> {
  const result = await ended(spawnCli(args, env, stdin))
  return result
}
