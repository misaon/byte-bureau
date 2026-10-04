import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
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

// A test that names no home for the CLI gets a throwaway one, never that of the person who runs the tests
// Its daemon, should the CLI start one on demand, listens on a free port
export function childEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return { ...BASE_ENV, BYTEBUREAU_HOME: env['BYTEBUREAU_HOME'] ?? testHome(), ...env }
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

type Child = ChildProcessByStdio<null, Readable, Readable>

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

// Runs the CLI from source in a Bun process; a process still alive when the test ends is killed
export async function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  interruption?: Interruption,
): Promise<CliResult> {
  const child = spawn('bun', ['run', 'src/main.ts', ...args], {
    cwd: CLI_DIRECTORY,
    env: childEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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
