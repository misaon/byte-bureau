import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { Deferred, Effect, Latch } from 'effect'
import { constVoid } from 'effect/Function'
import type { KillSignal } from './kill-ladder.js'

export interface ExitInfo {
  readonly code: number | null
  readonly signal: string | null
}

// How a process ended, or why it never started
interface Exited {
  readonly exit: ExitInfo
  readonly failure: string | null
}

interface LaunchSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

// A started child, or what is left of one that failed to start
export interface Launched {
  readonly pid: number
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  // To the child's whole process group, until the process is retired
  readonly kill: (signal: KillSignal) => void
  // The process has exited, or it never started
  readonly exited: Deferred.Deferred<Exited>
  // Every pipe of the child is released, which a grandchild that holds one can delay for good
  readonly closed: Latch.Latch
  // Nothing is left to signal; a pid that has been free for a while may belong to somebody else
  readonly retire: () => void
}

interface Gates {
  readonly exited: Deferred.Deferred<Exited>
  readonly closed: Latch.Latch
  readonly retired: Latch.Latch
}

// What a process that never started, such as a command that does not exist, reports
const NOT_STARTED: ExitInfo = { code: -1, signal: null }

const INVALID_ARGUMENT = 'ERR_INVALID_ARG'

// A system error says what it is; an invalid argument would echo the value, which may be a secret
export const describeFailure = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const code = 'code' in error ? error.code : undefined
  return typeof code === 'string' && code.startsWith(INVALID_ARGUMENT)
    ? `${code}: the command, an argument, the working directory or an environment value is invalid`
    : error.message
}

// The pids 0 and 1 would address the caller's own group and every process
const killGroup = (pid: number | undefined, signal: KillSignal): boolean => {
  if (pid === undefined || pid <= 1) {
    return false
  }
  try {
    return process.kill(-pid, signal)
  } catch {
    return false
  }
}

// A child leads a process group of its own, so what it started receives the signal as well
// Without a group, or with none left, the child is the one to signal
export const signalGroup = (
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: KillSignal,
): void => {
  if (!killGroup(child.pid, signal)) {
    child.kill(signal)
  }
}

const complete = <Value>(deferred: Deferred.Deferred<Value>, value: Value): void => {
  Deferred.doneUnsafe(deferred, Effect.succeed(value))
}

const makeGates = (): Gates => ({
  exited: Deferred.makeUnsafe<Exited>(),
  closed: Latch.makeUnsafe(),
  retired: Latch.makeUnsafe(),
})

// The listeners go on before anything else can run, since an error event nobody listens to throws
const watch = (child: ChildProcess, { exited, closed }: Gates): void => {
  child.on('exit', (code, signal) => {
    complete(exited, { exit: { code, signal }, failure: null })
  })
  child.on('close', (code, signal) => {
    complete(exited, { exit: { code, signal }, failure: null })
    Latch.openUnsafe(closed)
  })
  // A process that started only reports here that a signal could not be delivered
  child.on('error', (error) => {
    if (child.pid === undefined) {
      complete(exited, { exit: NOT_STARTED, failure: describeFailure(error) })
    }
  })
}

const started = (child: ChildProcess, gates: Gates): Launched => {
  watch(child, gates)
  const { exited, closed, retired } = gates
  return {
    pid: child.pid ?? -1,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: (signal) => {
      if (!Latch.isOpen(retired)) {
        signalGroup(child, signal)
      }
    },
    exited,
    closed,
    retire: () => {
      Latch.openUnsafe(retired)
    },
  }
}

const failed = (error: unknown, { exited, closed }: Gates): Launched => {
  complete(exited, { exit: NOT_STARTED, failure: describeFailure(error) })
  Latch.openUnsafe(closed)
  return { pid: -1, stdout: null, stderr: null, kill: constVoid, exited, closed, retire: constVoid }
}

// Whichever way the runtime reports that a process cannot start, an event or a throw, it ends the same
export function launch(spec: LaunchSpec, env: Record<string, string>): Launched {
  const gates = makeGates()
  try {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return started(child, gates)
  } catch (error) {
    return failed(error, gates)
  }
}
