import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Schedule,
  type Duration,
  type Scope,
  type Stream,
} from 'effect'
import { constVoid } from 'effect/Function'
import { Headers, HttpTraceContext } from 'effect/http'
import { nowIso, uuidv7 } from '../ids.js'
import { allowlistEnv } from './env-allowlist.js'
import { climb, ladderFor, TERMINATE_LADDER, type KillSignal } from './kill-ladder.js'
import { startPump, type OutputPump } from './pump.js'

export type { KillSignal } from './kill-ladder.js'

type ProcessKind = 'agent' | 'git' | 'helper'

export interface SpawnSpec {
  readonly kind: ProcessKind
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly passEnv?: readonly string[] | undefined
  readonly signal?: AbortSignal | undefined
  readonly maxLines?: number | undefined
}

export interface ExitInfo {
  readonly code: number | null
  readonly signal: string | null
}

export interface ManagedProcess {
  readonly id: string
  // -1 for a process that never started
  readonly pid: number
  // One consumer at a time; both end once the process has closed
  readonly stdout: Stream.Stream<string>
  readonly stderr: Stream.Stream<string>
  // Resolves when the process has closed and both streams have ended
  readonly exit: Effect.Effect<ExitInfo>
  // Without a signal the whole ladder runs, with one that signal alone is sent
  readonly kill: (signal?: KillSignal) => Effect.Effect<void>
  readonly recentStderr: () => readonly string[]
}

export interface ProcessInfo {
  readonly id: string
  readonly kind: ProcessKind
  readonly command: string
  readonly pid: number
  readonly startedAt: string
}

interface SupervisorShape {
  readonly spawn: (spec: SpawnSpec) => Effect.Effect<ManagedProcess, never, Scope.Scope>
  readonly kill: (id: string, signal?: KillSignal) => Effect.Effect<void>
  readonly list: () => Effect.Effect<readonly ProcessInfo[]>
}

export class Supervisor extends Context.Service<Supervisor, SupervisorShape>()('bb/Supervisor') {}

const DEFAULT_MAX_LINES = 10_000

// What a process that never started, such as a command that does not exist, reports
const NOT_STARTED: ExitInfo = { code: -1, signal: null }

// Backoff between restarts of a crashed process: 500 ms doubling, jittered, at most maxRestarts times
export const restartSchedule = (maxRestarts: number): Schedule.Schedule<Duration.Duration> =>
  Schedule.max([
    Schedule.exponential('500 millis').pipe(Schedule.jittered),
    Schedule.recurs(maxRestarts),
  ])

const traceparent: Effect.Effect<Record<string, string>> = Effect.currentSpan.pipe(
  Effect.option,
  Effect.map(
    Option.flatMap((span) => Headers.get(HttpTraceContext.toHeaders(span), 'traceparent')),
  ),
  Effect.map(
    Option.match({
      onNone: (): Record<string, string> => ({}),
      onSome: (value): Record<string, string> => ({ TRACEPARENT: value }),
    }),
  ),
)

const childEnv = (spec: SpawnSpec): Effect.Effect<Record<string, string>> =>
  traceparent.pipe(
    Effect.map((trace) => ({
      ...allowlistEnv(process.env, spec.passEnv),
      ...allowlistEnv(spec.env ?? {}, spec.passEnv),
      ...trace,
    })),
  )

// Why a process closed: how it ended, or why it never started
interface Closed {
  readonly exit: ExitInfo
  readonly failure: string | null
}

// A started child, or what is left of one that failed to start
interface Launched {
  readonly pid: number
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly kill: (signal: KillSignal) => void
  readonly closed: Deferred.Deferred<Closed>
}

// Whichever way the runtime reports a start failure, an event or a throw, it ends as the same Closed
// The listeners go on before anything else can run, since an error event nobody listens to throws
function launch(spec: SpawnSpec, env: Record<string, string>): Launched {
  const closed = Deferred.makeUnsafe<Closed>()
  const settle = (value: Closed): void => {
    Deferred.doneUnsafe(closed, Effect.succeed(value))
  }
  try {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.on('close', (code, signal) => {
      settle({ exit: { code, signal }, failure: null })
    })
    // A process that started only reports here that a signal could not be delivered
    child.on('error', (error) => {
      if (child.pid === undefined) {
        settle({ exit: NOT_STARTED, failure: error.message })
      }
    })
    const kill = (signal: KillSignal): void => {
      child.kill(signal)
    }
    return { pid: child.pid ?? -1, stdout: child.stdout, stderr: child.stderr, kill, closed }
  } catch (error) {
    settle({ exit: NOT_STARTED, failure: error instanceof Error ? error.message : String(error) })
    return { pid: -1, stdout: null, stderr: null, kill: constVoid, closed }
  }
}

const killer =
  (launched: Launched): ManagedProcess['kill'] =>
  (signal) =>
    climb(ladderFor(signal), launched.kill, Deferred.await(launched.closed))

// Scope close: SIGTERM, then SIGKILL when the process ignores it for ten seconds
const terminate = (launched: Launched, exit: Effect.Effect<ExitInfo>): Effect.Effect<void> =>
  climb(TERMINATE_LADDER, launched.kill, Deferred.await(launched.closed)).pipe(
    Effect.andThen(exit),
    Effect.asVoid,
  )

const awaitAbort = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback((resume) => {
    const onAbort = (): void => {
      resume(Effect.void)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
    }
    return Effect.sync(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })

const killOnAbort = (signal: AbortSignal, managed: ManagedProcess): Effect.Effect<void> =>
  Effect.andThen(awaitAbort(signal), managed.kill())

interface Running {
  readonly id: string
  readonly launched: Launched
  readonly stdout: OutputPump
  readonly stderr: OutputPump
}

const startRunning = (spec: SpawnSpec): Effect.Effect<Running> =>
  Effect.gen(function* startsProcess() {
    const env = yield* childEnv(spec)
    const launched = launch(spec, env)
    const limit = spec.maxLines ?? DEFAULT_MAX_LINES
    // Only stderr is kept for diagnostics, stdout is streamed and nothing else
    const stdout = yield* startPump(launched.stdout, 0)
    const stderr = yield* startPump(launched.stderr, limit)
    return { id: uuidv7(), launched, stdout, stderr }
  })

// The process has closed: a failure to start reaches stderr, both pumps run dry, the registry lets go
const settleExit = (running: Running, release: () => void): Effect.Effect<ExitInfo> =>
  Effect.gen(function* settlesExit() {
    const { exit, failure } = yield* Deferred.await(running.launched.closed)
    release()
    if (failure !== null) {
      running.stderr.append(failure)
    }
    yield* running.stdout.finish
    yield* running.stderr.finish
    return exit
  })

const present = (running: Running, exit: Effect.Effect<ExitInfo>): ManagedProcess => ({
  id: running.id,
  pid: running.launched.pid,
  stdout: running.stdout.lines,
  stderr: running.stderr.lines,
  exit,
  kill: killer(running.launched),
  recentStderr: running.stderr.recent,
})

interface Entry {
  readonly info: ProcessInfo
  readonly kill: ManagedProcess['kill']
}

type Registry = Map<string, Entry>

const entryOf = (spec: SpawnSpec, running: Running): Entry => ({
  info: {
    id: running.id,
    kind: spec.kind,
    command: spec.command,
    pid: running.launched.pid,
    startedAt: nowIso(),
  },
  kill: killer(running.launched),
})

// Every fiber and finalizer hangs on the caller's scope, not on the fiber that happens to spawn
// The finalizer goes last, so it runs first: the process is gone before its fibers are interrupted
const spawnProcess = (
  registry: Registry,
  spec: SpawnSpec,
): Effect.Effect<ManagedProcess, never, Scope.Scope> =>
  Effect.gen(function* spawnManaged() {
    const running = yield* startRunning(spec)
    registry.set(running.id, entryOf(spec, running))
    const release = (): void => {
      registry.delete(running.id)
    }
    const settled = yield* Effect.forkScoped(settleExit(running, release))
    const managed = present(running, Fiber.join(settled))
    yield* Effect.addFinalizer(() => terminate(running.launched, managed.exit))
    if (spec.signal !== undefined) {
      yield* Effect.forkScoped(killOnAbort(spec.signal, managed))
    }
    return managed
  })

const killById = (
  registry: Registry,
  id: string,
  signal: KillSignal | undefined,
): Effect.Effect<void> => {
  const entry = registry.get(id)
  return entry === undefined ? Effect.void : entry.kill(signal)
}

const make = Effect.sync(() => {
  const registry: Registry = new Map()
  return Supervisor.of({
    spawn: (spec) => spawnProcess(registry, spec),
    kill: (id, signal) => killById(registry, id, signal),
    list: () => Effect.sync(() => [...registry.values()].map((entry) => entry.info)),
  })
})

export const SupervisorLive: Layer.Layer<Supervisor> = Layer.effect(Supervisor, make)
