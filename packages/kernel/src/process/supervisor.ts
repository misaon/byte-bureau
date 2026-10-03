import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schedule,
  type Duration,
  type Scope,
  type Stream,
} from 'effect'
import { nowIso, uuidv7 } from '../ids.js'
import { childEnv } from './child-env.js'
import { launch, type ExitInfo, type Launched } from './launch.js'
import { climb, ladderFor, TERMINATE_LADDER, type KillSignal } from './kill-ladder.js'
import { startPump, type OutputPump } from './pump.js'

export type { ExitInfo } from './launch.js'
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
  // Bounds only recentStderr(); a stream nobody reads keeps every line queued in memory
  readonly maxLines?: number | undefined
}

export interface ManagedProcess {
  readonly id: string
  // -1 for a process that never started
  readonly pid: number
  // One consumer at a time; lines nobody has read stay queued in memory until they are
  readonly stdout: Stream.Stream<string>
  readonly stderr: Stream.Stream<string>
  // Resolves once the process has exited and its output is queued, two seconds after the exit at most
  readonly exit: Effect.Effect<ExitInfo>
  // Without a signal the whole ladder runs, with one that signal alone is sent; the signal goes to the process group
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

// How long the pipes of an exited process get to run dry; a grandchild that holds one can keep it open for good
const DRAIN = '2 seconds'

// Backoff between restarts of a crashed process: 500 ms doubling, jittered, at most maxRestarts times
export const restartSchedule = (maxRestarts: number): Schedule.Schedule<Duration.Duration> =>
  Schedule.max([
    Schedule.exponential('500 millis').pipe(Schedule.jittered),
    Schedule.recurs(maxRestarts),
  ])

const killer =
  (launched: Launched): ManagedProcess['kill'] =>
  (signal) =>
    climb(ladderFor(signal), launched.kill, Deferred.await(launched.exited))

// Scope close: SIGTERM, then SIGKILL when the process ignores it for ten seconds
const terminate = (launched: Launched, exit: Effect.Effect<ExitInfo>): Effect.Effect<void> =>
  climb(TERMINATE_LADDER, launched.kill, Deferred.await(launched.exited)).pipe(
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
    // Only stderr is kept for diagnostics, stdout is streamed and nothing else
    const stdout = yield* startPump(launched.stdout, 0)
    const stderr = yield* startPump(launched.stderr, spec.maxLines ?? DEFAULT_MAX_LINES)
    return { id: uuidv7(), launched, stdout, stderr }
  })

// The process has exited: the registry lets go at once, its pipes get two seconds to run dry and both pumps finish
// The pipes are what a grandchild can hold open, the process itself is what exit reports
const settleExit = (running: Running, release: () => void): Effect.Effect<ExitInfo> =>
  Effect.gen(function* settlesExit() {
    const { launched } = running
    const { exit, failure } = yield* Deferred.await(launched.exited)
    release()
    yield* Effect.timeoutOption(launched.closed.await, DRAIN)
    if (failure !== null) {
      running.stderr.append(failure)
    }
    yield* running.stdout.finish
    yield* running.stderr.finish
    launched.retire()
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

// The fibers and the finalizer hang on the caller's scope, not on the fiber that happens to spawn
// The settle fiber is forked before the finalizer, so the finalizer runs first and the process is gone before it is interrupted
// The abort watcher is forked after the finalizer and is interrupted first, which does no harm
// Nothing may interrupt the spawn halfway: a process without its finalizer would be orphaned
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
  }).pipe(Effect.uninterruptible)

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
