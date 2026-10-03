import { getEventListeners } from 'node:events'
import type { ExecHandle } from '@bytebureau/plugin-api'
import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import { IDLE, withEnv } from '../process/supervisor-fixtures.js'
import { linesOf, nodeExec, resolved } from './plugin-call-fixtures.js'
import { hostOver, loadedHost, probe } from './plugin-fixtures.js'
import type { PluginHost } from './plugin-host.js'

const spawner = probe('spawner')

// Real child processes, so the supervisor runs on the real clock
const live = { excludeTestServices: true }

const spawn = (
  ...args: Parameters<typeof nodeExec>
): Effect.Effect<ExecHandle, never, PluginHost> =>
  Effect.gen(function* spawnsScript() {
    yield* loadedHost
    return yield* resolved(spawner.context().process.spawn(nodeExec(...args)))
  })

it.layer(hostOver({ extraPlugins: [spawner.plugin] }), live)('plugin context process', (suite) => {
  suite.effect('runs a command and reports its lines, its pid and its exit code', () =>
    Effect.gen(function* runsCommand() {
      const handle = yield* spawn('console.log("one"); console.error("two"); process.exit(3)')
      assert.deepStrictEqual(yield* linesOf(handle.stdout), ['one'])
      assert.deepStrictEqual(yield* linesOf(handle.stderr), ['two'])
      assert.deepStrictEqual(yield* resolved(handle.exited), { code: 3, signal: null })
      assert.isAbove(handle.pid, 0)
    }),
  )

  suite.effect('hands the child the environment the plugin declares and none of the daemon', () =>
    Effect.gen(function* declaresEnvironment() {
      yield* withEnv('BB_PLUGIN_LEAK', 'daemon')
      const script =
        'console.log(process.env.BB_DECLARED); console.log(process.env.BB_PLUGIN_LEAK ?? "dropped")'
      const handle = yield* spawn(script, { env: { BB_DECLARED: 'yes' } })
      assert.deepStrictEqual(yield* linesOf(handle.stdout), ['yes', 'dropped'])
    }),
  )

  suite.effect('reports a command that cannot start as exit -1 with the reason on stderr', () =>
    Effect.gen(function* reportsMissingCommand() {
      const handle = yield* spawn('', { command: 'bb-no-such-command' })
      assert.strictEqual(handle.pid, -1)
      assert.deepStrictEqual(yield* resolved(handle.exited), { code: -1, signal: null })
      assert.isAbove((yield* linesOf(handle.stderr)).length, 0)
    }),
  )
})

it.layer(hostOver({ extraPlugins: [spawner.plugin] }), live)(
  'plugin context process end',
  (suite) => {
    suite.effect('ends a command that outlives its timeout', () =>
      Effect.gen(function* endsOnTimeout() {
        const handle = yield* spawn(IDLE, { timeoutMs: 100 })
        assert.deepStrictEqual(yield* resolved(handle.exited), { code: null, signal: 'SIGINT' })
      }),
    )

    suite.effect('leaves a command alone that ends before its timeout', () =>
      Effect.gen(function* leavesQuickCommand() {
        const handle = yield* spawn('process.exit(0)', { timeoutMs: 60_000 })
        assert.deepStrictEqual(yield* resolved(handle.exited), { code: 0, signal: null })
      }),
    )

    suite.effect('ends a command when the plugin aborts its signal', () =>
      Effect.gen(function* endsOnAbort() {
        const controller = new AbortController()
        const handle = yield* spawn(IDLE, { signal: controller.signal })
        controller.abort()
        assert.deepStrictEqual(yield* resolved(handle.exited), { code: null, signal: 'SIGINT' })
      }),
    )

    suite.effect('sends the signal the plugin names when it kills the command', () =>
      Effect.gen(function* killsOnRequest() {
        const handle = yield* spawn(IDLE)
        handle.kill('SIGKILL')
        assert.deepStrictEqual(yield* resolved(handle.exited), { code: null, signal: 'SIGKILL' })
      }),
    )
  },
)

const listenersOf = (signal: AbortSignal): Effect.Effect<number> =>
  Effect.sync(() => getEventListeners(signal, 'abort').length)

it.layer(hostOver({ extraPlugins: [spawner.plugin] }), live)(
  'plugin context process cleanup',
  (suite) => {
    suite.effect('lets go of the abort signal of the plugin once the command has ended', () =>
      Effect.gen(function* releasesSignal() {
        const { signal } = new AbortController()
        const handle = yield* spawn('process.exit(0)', { signal })
        yield* resolved(handle.exited)
        const listening = Effect.repeat(listenersOf(signal), { until: (count) => count === 0 })
        assert.strictEqual(yield* Effect.timeout(listening, '2 seconds'), 0)
      }),
    )
  },
)
