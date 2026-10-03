import { Effect, Exit, Queue, Scope, Stream, type Cause } from 'effect'
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
