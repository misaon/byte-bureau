import { assert, it, vi } from '@effect/vitest'
import { Effect, Exit, Fiber, Queue, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { Supervisor, SupervisorLive } from './supervisor.js'
import {
  awaitReady,
  ESCAPED_HOLDER,
  hasEnded,
  HOLDER,
  IDLE,
  isPending,
  nodeSpec,
  ownScope,
  REAPING_HOLDER,
  spawnHolder,
  untilUnlisted,
} from './supervisor-fixtures.js'

// A grandchild that holds the pipes keeps the child's close event away, which exit must not wait for
it.layer(SupervisorLive)('Supervisor drain bound', (suite) => {
  suite.effect('resolves exit two seconds after a child whose grandchild left the group', () =>
    Effect.gen(function* boundsDrain() {
      const supervisor = yield* Supervisor
      const { child, lines } = yield* spawnHolder(supervisor, ESCAPED_HOLDER)
      yield* child.kill('SIGKILL')
      yield* untilUnlisted(supervisor)
      yield* TestClock.adjust('1999 millis')
      assert.ok(yield* isPending(child.exit))
      yield* TestClock.adjust('1 millis')
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGKILL' })
      assert.ok(yield* hasEnded(lines))
    }),
  )

  suite.effect('closes the scope within the same bound', () =>
    Effect.gen(function* closesBounded() {
      const supervisor = yield* Supervisor
      const scope = yield* ownScope
      const { child } = yield* spawnHolder(supervisor, ESCAPED_HOLDER, scope)
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void), {
        startImmediately: true,
      })
      yield* untilUnlisted(supervisor)
      yield* TestClock.adjust('2 seconds')
      yield* Fiber.join(closing)
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGTERM' })
    }),
  )
})

// A pid that has been free for a while may belong to somebody else, so a released process gets no signal
it.layer(SupervisorLive)('Supervisor released process', (suite) => {
  suite.effect('sends no signal to the group once the process has exited and been released', () =>
    Effect.gen(function* retiresProcess() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(nodeSpec(IDLE))
      yield* awaitReady(child)
      yield* child.kill()
      yield* child.exit
      const killGroup = vi.spyOn(process, 'kill').mockReturnValue(true)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          killGroup.mockRestore()
        }),
      )
      yield* child.kill('SIGTERM')
      assert.strictEqual(killGroup.mock.calls.length, 0)
    }),
  )
})

it.layer(SupervisorLive)('Supervisor process group', (suite) => {
  suite.effect('ends a grandchild of the same group with the child, so exit needs no drain', () =>
    Effect.gen(function* endsGroup() {
      const supervisor = yield* Supervisor
      const { child } = yield* spawnHolder(supervisor, HOLDER)
      yield* child.kill()
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGINT' })
    }),
  )

  suite.effect('signals the whole group and not only the child', () =>
    Effect.gen(function* signalsGroup() {
      const supervisor = yield* Supervisor
      const { child, lines, grandchildPid } = yield* spawnHolder(supervisor, REAPING_HOLDER)
      yield* child.kill('SIGINT')
      assert.strictEqual(yield* Queue.take(lines), 'grandchild SIGINT')
      assert.throws(() => {
        process.kill(grandchildPid, 0)
      }, /ESRCH/u)
      yield* child.kill('SIGKILL')
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGKILL' })
    }),
  )
})
