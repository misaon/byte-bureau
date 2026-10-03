import { assert, describe, it } from '@effect/vitest'
import { Cause, Duration, Effect, Exit, Fiber, Schedule, Scope, Stream } from 'effect'
import {
  restartSchedule,
  Supervisor,
  SupervisorLive,
  type ProcessInfo,
  type SpawnSpec,
} from './supervisor.js'
import { awaitReady, IDLE, node, nodeSpec, ownScope, withEnv } from './supervisor-fixtures.js'

const TRACE = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`

const numbered = (prefix: string): string[] =>
  Array.from({ length: 20 }, (_value, index) => `${prefix}${index}`)

const withoutStamp = ({
  startedAt: _startedAt,
  ...rest
}: ProcessInfo): Omit<ProcessInfo, 'startedAt'> => rest

const hasIsoStamp = ({ startedAt }: ProcessInfo): boolean =>
  new Date(startedAt).toISOString() === startedAt

// A process that cannot start reports exit code -1, a pid of -1 and only the reason on stderr
const failsToStart = (
  spec: SpawnSpec,
): Effect.Effect<readonly string[], never, Supervisor | Scope.Scope> =>
  Effect.gen(function* failsToStartGen() {
    const supervisor = yield* Supervisor
    const child = yield* supervisor.spawn(spec)
    assert.deepStrictEqual(yield* child.exit, { code: -1, signal: null })
    assert.strictEqual(child.pid, -1)
    assert.deepStrictEqual(yield* Stream.runCollect(child.stdout), [])
    const reasons = yield* Stream.runCollect(child.stderr)
    assert.deepStrictEqual(child.recentStderr(), reasons)
    assert.deepStrictEqual(yield* supervisor.list(), [])
    return reasons
  })

// Without a test clock, so the child processes run in real time
const live = { excludeTestServices: true }

it.layer(SupervisorLive, live)('Supervisor environment', (suite) => {
  suite.effect('streams stdout lines, passes only allowlisted env and reports the exit code', () =>
    Effect.gen(function* streamsOutput() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(
        nodeSpec(
          'console.log("one"); console.log(process.env.SECRET ?? "no-secret"); console.log(process.env.KEEP); process.exit(3)',
          { env: { SECRET: 'x', KEEP: 'y' }, passEnv: ['KEEP'] },
        ),
      )
      const lines = yield* Stream.runCollect(child.stdout)
      assert.deepStrictEqual(lines, ['one', 'no-secret', 'y'])
      assert.deepStrictEqual(yield* child.exit, { code: 3, signal: null })
    }),
  )

  suite.effect('keeps the daemon environment out of the child except the allowlist', () =>
    Effect.gen(function* dropsDaemonEnvironment() {
      yield* withEnv('ANTHROPIC_API_KEY', 'not-a-real-key')
      yield* withEnv('BYTEBUREAU_TEST_MARK', 'kept')
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(
        nodeSpec(
          'console.log(process.env.ANTHROPIC_API_KEY ?? "dropped"); console.log(process.env.BYTEBUREAU_TEST_MARK); console.log(typeof process.env.PATH)',
        ),
      )
      const lines = yield* Stream.runCollect(child.stdout)
      assert.deepStrictEqual(lines, ['dropped', 'kept', 'string'])
    }),
  )
})

it.layer(SupervisorLive, live)('Supervisor tracing', (suite) => {
  suite.effect('hands the current span to the child as TRACEPARENT', () =>
    Effect.gen(function* passesSpan() {
      yield* withEnv('TRACEPARENT', TRACE)
      const supervisor = yield* Supervisor
      const span = yield* Effect.currentSpan
      const child = yield* supervisor.spawn(nodeSpec('console.log(process.env.TRACEPARENT)'))
      const flags = span.sampled ? '01' : '00'
      const lines = yield* Stream.runCollect(child.stdout)
      assert.deepStrictEqual(lines, [`00-${span.traceId}-${span.spanId}-${flags}`])
    }).pipe(Effect.withSpan('parent')),
  )

  suite.effect('passes the daemon own TRACEPARENT on when no span is active', () =>
    Effect.gen(function* passesAmbientTrace() {
      yield* withEnv('TRACEPARENT', TRACE)
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(nodeSpec('console.log(process.env.TRACEPARENT)'))
      assert.deepStrictEqual(yield* Stream.runCollect(child.stdout), [TRACE])
    }),
  )
})

it.layer(SupervisorLive, live)('Supervisor line streams', (suite) => {
  suite.effect('splits CRLF and unterminated lines and keeps each stream in its own order', () =>
    Effect.gen(function* splitsLines() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(
        nodeSpec(
          String.raw`for (let i = 0; i < 20; i++) { process.stdout.write("o" + i + "\r\n"); process.stderr.write("e" + i + "\n") } process.stdout.write("tail")`,
        ),
      )
      assert.deepStrictEqual(yield* Stream.runCollect(child.stdout), [...numbered('o'), 'tail'])
      assert.deepStrictEqual(yield* Stream.runCollect(child.stderr), numbered('e'))
    }),
  )

  suite.effect('delivers every line of an output that outgrows the pipe buffer', () =>
    Effect.gen(function* deliversLongOutput() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(
        nodeSpec(
          'for (let i = 0; i < 20000; i++) console.log("line-" + i); process.stdout.write("tail")',
        ),
      )
      const lines = yield* Stream.runCollect(child.stdout)
      assert.strictEqual(lines.length, 20_001)
      assert.deepStrictEqual(lines.slice(0, 2), ['line-0', 'line-1'])
      assert.deepStrictEqual(lines.slice(-2), ['line-19999', 'tail'])
    }),
  )

  suite.effect(
    'keeps the newest stderr lines for diagnostics although nobody reads the stream',
    () =>
      Effect.gen(function* keepsStderr() {
        const supervisor = yield* Supervisor
        const child = yield* supervisor.spawn(
          nodeSpec('for (const n of [1, 2, 3, 4, 5]) console.error("e" + n)', { maxLines: 3 }),
        )
        yield* child.exit
        assert.deepStrictEqual(child.recentStderr(), ['e3', 'e4', 'e5'])
        assert.deepStrictEqual(yield* Stream.runCollect(child.stderr), [
          'e1',
          'e2',
          'e3',
          'e4',
          'e5',
        ])
      }),
  )
})

it.layer(SupervisorLive, live)('Supervisor registry', (suite) => {
  suite.effect('lists a running process until it exits', () =>
    Effect.gen(function* listsRunning() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(nodeSpec(IDLE))
      yield* awaitReady(child)
      const listed = yield* supervisor.list()
      assert.deepStrictEqual(
        listed.map((info) => withoutStamp(info)),
        [{ id: child.id, kind: 'helper', command: node, pid: child.pid }],
      )
      assert.ok(listed.every((info) => hasIsoStamp(info)))
      yield* child.kill('SIGKILL')
      yield* child.exit
      assert.deepStrictEqual(yield* supervisor.list(), [])
    }),
  )

  suite.effect('keeps streaming after the fiber that spawned the process has ended', () =>
    Effect.gen(function* outlivesSpawner() {
      const supervisor = yield* Supervisor
      const scope = yield* ownScope
      const spawning = supervisor
        .spawn(nodeSpec('console.log("a"); console.log("b")'))
        .pipe(Effect.provideService(Scope.Scope, scope))
      const child = yield* Fiber.join(yield* Effect.forkChild(spawning))
      assert.deepStrictEqual(yield* Stream.runCollect(child.stdout), ['a', 'b'])
      assert.deepStrictEqual(yield* child.exit, { code: 0, signal: null })
      yield* Scope.close(scope, Exit.void)
    }),
  )
})

it.layer(SupervisorLive, live)('Supervisor start failures', (suite) => {
  suite.effect('reports a command that does not exist', () =>
    Effect.gen(function* reportsMissingCommand() {
      const command = 'bytebureau-no-such-command'
      const reasons = yield* failsToStart({ kind: 'helper', command, args: [], cwd: process.cwd() })
      assert.strictEqual(reasons.length, 1)
      assert.ok(reasons.every((line) => line.includes(command)))
    }),
  )

  suite.effect('reports a working directory that does not exist', () =>
    Effect.gen(function* reportsMissingDirectory() {
      const reasons = yield* failsToStart(nodeSpec('1', { cwd: '/bytebureau/no/such/directory' }))
      assert.strictEqual(reasons.length, 1)
    }),
  )

  suite.effect('reports a working directory that is a file', () =>
    Effect.gen(function* reportsFileAsDirectory() {
      const reasons = yield* failsToStart(nodeSpec('1', { cwd: node }))
      assert.strictEqual(reasons.length, 1)
    }),
  )

  suite.effect('reports an argument the runtime refuses', () =>
    Effect.gen(function* reportsInvalidArgument() {
      const reasons = yield* failsToStart(nodeSpec('1\0'))
      assert.strictEqual(reasons.length, 1)
    }),
  )
})

describe(restartSchedule, () => {
  it.effect('backs off exponentially with jitter and gives up after the limit', () =>
    Effect.gen(function* backsOff() {
      const step = yield* Schedule.toStep(restartSchedule(2))
      const [, first] = yield* step(0, null)
      const [, second] = yield* step(0, null)
      const [firstMillis, secondMillis] = [Duration.toMillis(first), Duration.toMillis(second)]
      assert.ok(firstMillis >= 400 && firstMillis <= 600)
      assert.ok(secondMillis >= 800 && secondMillis <= 1200)
      const exhausted = yield* Effect.flip(step(0, null))
      assert.ok(Cause.isDone(exhausted))
    }),
  )
})
