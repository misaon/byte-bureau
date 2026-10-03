import { Effect, Exit, Option, Queue, Scope, Stream, type Cause } from 'effect'
import type { ManagedProcess, SpawnSpec, Supervisor } from './supervisor.js'

export const node = process.execPath

// A helper process that runs one Node script
export const nodeSpec = (script: string, rest: Partial<SpawnSpec> = {}): SpawnSpec => ({
  kind: 'helper',
  command: node,
  args: ['-e', script],
  cwd: process.cwd(),
  ...rest,
})

// Announces itself once it runs, then idles until a signal ends it
export const IDLE = 'console.log("ready"); setInterval(() => {}, 1000)'

// Reports SIGINT and SIGTERM instead of dying from them, so only SIGKILL ends it
const STUBBORN = `for (const name of ["SIGINT", "SIGTERM"]) process.on(name, () => console.log(name)); ${IDLE}`

type Lines = Queue.Dequeue<string, Cause.Done>

// The lines of a stream, taken one at a time; taking past the end of the stream fails
const lineQueue = (stream: Stream.Stream<string>): Effect.Effect<Lines, never, Scope.Scope> =>
  Effect.gen(function* collectsLines() {
    const queue = yield* Queue.unbounded<string, Cause.Done>()
    const feeding = Stream.runForEach(stream, (line) => Queue.offer(queue, line)).pipe(
      Effect.ensuring(Queue.end(queue)),
    )
    yield* Effect.forkScoped(feeding)
    return queue
  })

// The child has printed "ready", so its signal handlers are installed
export const awaitReady = (child: ManagedProcess): Effect.Effect<Lines, Cause.Done, Scope.Scope> =>
  Effect.gen(function* awaitsReady() {
    const lines = yield* lineQueue(child.stdout)
    yield* Queue.take(lines)
    return lines
  })

// The child starts a grandchild that inherits the pipes and idles, then prints the grandchild's pid
const startsGrandchild = (detached: boolean): string =>
  `const grand = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit", detached: ${detached} }); console.log("up " + grand.pid)`

// The grandchild is in the child's process group: a signal to the group reaches both
export const HOLDER = `${startsGrandchild(false)}; setInterval(() => {}, 1000)`

// The grandchild has left the group, so only a pipe ties it to the child
export const ESCAPED_HOLDER = `${startsGrandchild(true)}; setInterval(() => {}, 1000)`

// Writes a line every 20 ms; a write that fails, as one to a pipe nobody reads any more does, ends the process
const WRITER = String.raw`setInterval(() => process.stdout.write('tick\n'), 20)`

// The grandchild has left the group and writes to the pipe it shares with the child
export const WRITING_HOLDER = `const grand = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(WRITER)}], { stdio: "inherit", detached: true }); console.log("up " + grand.pid); setInterval(() => {}, 1000)`

// Whether a process of that pid still exists
export const isAlive = (pid: number): boolean => {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

// Ignores SIGINT and reports how its grandchild ends, which only the grandchild's parent, which reaps it, can see
export const REAPING_HOLDER = `process.on("SIGINT", () => {}); ${startsGrandchild(false)}; grand.on("exit", (code, signal) => console.log("grandchild " + signal)); setInterval(() => {}, 1000)`

// Only SIGKILL ends it, so the test's own scope sends that when the test ends, or fails halfway
export const spawnStubborn = (
  supervisor: Supervisor['Service'],
  scope?: Scope.Scope,
): Effect.Effect<ManagedProcess, never, Scope.Scope> =>
  Effect.gen(function* spawnsStubborn() {
    const spawning = supervisor.spawn(nodeSpec(STUBBORN))
    const child = yield* scope === undefined
      ? spawning
      : Effect.provideService(spawning, Scope.Scope, scope)
    yield* Effect.addFinalizer(() => child.kill('SIGKILL'))
    return child
  })

// A scope of the test's own, closed with the test's scope unless the test closed it before
export const ownScope: Effect.Effect<Scope.Closeable, never, Scope.Scope> = Effect.acquireRelease(
  Scope.make(),
  (scope) => Scope.close(scope, Exit.void),
)

// Sets a variable of this process until the test's scope closes
export const withEnv = (name: string, value: string): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const before = process.env[name]
      process.env[name] = value
      return before
    }),
    (before) =>
      Effect.sync(() => {
        if (before === undefined) {
          Reflect.deleteProperty(process.env, name)
        } else {
          process.env[name] = before
        }
      }),
  ).pipe(Effect.asVoid)

const killQuietly = (pid: number): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The process is gone already
    }
  })

interface Held {
  readonly child: ManagedProcess
  readonly lines: Lines
  readonly grandchildPid: number
}

// A child with a grandchild on its pipes; both are killed when the test's scope closes, whatever the test did
export const spawnHolder = (
  supervisor: Supervisor['Service'],
  script: string,
  scope?: Scope.Scope,
): Effect.Effect<Held, Cause.Done, Scope.Scope> =>
  Effect.gen(function* spawnsHolder() {
    const spawning = supervisor.spawn(nodeSpec(script))
    const child = yield* scope === undefined
      ? spawning
      : Effect.provideService(spawning, Scope.Scope, scope)
    yield* Effect.addFinalizer(() => child.kill('SIGKILL'))
    const lines = yield* lineQueue(child.stdout)
    const grandchildPid = Number((yield* Queue.take(lines)).replace('up ', ''))
    yield* Effect.addFinalizer(() => killQuietly(grandchildPid))
    return { child, lines, grandchildPid }
  })

// The registry lets go of a process as soon as it has exited, which real events decide, hence the turns of the event loop
export const untilUnlisted = (supervisor: Supervisor['Service']): Effect.Effect<void> =>
  Effect.gen(function* waitsForExit() {
    while ((yield* supervisor.list()).length > 0) {
      yield* Effect.yieldNow
    }
  })

// Under the test clock a timeout of zero ends at once, so this tells whether the effect has completed yet
export const isPending = (effect: Effect.Effect<unknown>): Effect.Effect<boolean> =>
  Effect.map(Effect.timeoutOption(effect, 0), (done) => Option.isNone(done))

// The stream behind the queue has ended: taking another line fails
export const hasEnded = (lines: Lines): Effect.Effect<boolean> =>
  Effect.map(Effect.exit(Queue.take(lines)), (taken) => Exit.isFailure(taken))
