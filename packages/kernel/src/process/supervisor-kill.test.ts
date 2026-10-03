import { getEventListeners } from 'node:events'
import { assert, it } from '@effect/vitest'
import { Effect, Exit, Fiber, Queue, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { Supervisor, SupervisorLive } from './supervisor.js'
import { awaitReady, IDLE, nodeSpec, ownScope, spawnStubborn } from './supervisor-fixtures.js'

it.layer(SupervisorLive)('Supervisor kill ladder', (suite) => {
  suite.effect('escalates SIGINT, SIGTERM after 5 s and SIGKILL after another 10 s', () =>
    Effect.gen(function* escalates() {
      const supervisor = yield* Supervisor
      const child = yield* spawnStubborn(supervisor)
      const lines = yield* awaitReady(child)
      const killing = yield* Effect.forkChild(child.kill(), { startImmediately: true })
      assert.strictEqual(yield* Queue.take(lines), 'SIGINT')
      yield* TestClock.adjust('5 seconds')
      assert.strictEqual(yield* Queue.take(lines), 'SIGTERM')
      yield* TestClock.adjust('10 seconds')
      yield* Fiber.join(killing)
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGKILL' })
    }),
  )

  suite.effect('stops at SIGINT when the process exits, without waiting out the grace period', () =>
    Effect.gen(function* stopsEarly() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(nodeSpec(IDLE))
      yield* awaitReady(child)
      yield* child.kill()
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGINT' })
    }),
  )

  suite.effect('sends only the signal it is given and does not wait', () =>
    Effect.gen(function* sendsOneSignal() {
      const supervisor = yield* Supervisor
      const child = yield* spawnStubborn(supervisor)
      const lines = yield* awaitReady(child)
      yield* child.kill('SIGTERM')
      assert.strictEqual(yield* Queue.take(lines), 'SIGTERM')
      yield* child.kill('SIGKILL')
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGKILL' })
    }),
  )
})

it.layer(SupervisorLive)('Supervisor kill by id', (suite) => {
  suite.effect('kills by id with the ladder and ignores an id nobody holds', () =>
    Effect.gen(function* killsById() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(nodeSpec(IDLE))
      yield* awaitReady(child)
      yield* supervisor.kill('no-such-process')
      yield* supervisor.kill(child.id)
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGINT' })
      assert.deepStrictEqual(yield* supervisor.list(), [])
    }),
  )

  suite.effect('kills by id with the signal it is given', () =>
    Effect.gen(function* killsByIdWithSignal() {
      const supervisor = yield* Supervisor
      const child = yield* spawnStubborn(supervisor)
      yield* awaitReady(child)
      yield* supervisor.kill(child.id, 'SIGKILL')
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGKILL' })
    }),
  )
})

it.layer(SupervisorLive)('Supervisor scope', (suite) => {
  suite.effect('terminates a running process when its scope closes', () =>
    Effect.gen(function* closesScope() {
      const supervisor = yield* Supervisor
      const scope = yield* ownScope
      const spawning = supervisor
        .spawn(nodeSpec(IDLE))
        .pipe(Effect.provideService(Scope.Scope, scope))
      const child = yield* spawning
      yield* awaitReady(child)
      yield* Scope.close(scope, Exit.void)
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGTERM' })
      assert.deepStrictEqual(yield* supervisor.list(), [])
    }),
  )

  suite.effect('kills a process that ignores SIGTERM ten seconds after its scope closes', () =>
    Effect.gen(function* escalatesOnClose() {
      const supervisor = yield* Supervisor
      const scope = yield* ownScope
      const child = yield* spawnStubborn(supervisor, scope)
      const lines = yield* awaitReady(child)
      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void), {
        startImmediately: true,
      })
      assert.strictEqual(yield* Queue.take(lines), 'SIGTERM')
      yield* TestClock.adjust('10 seconds')
      yield* Fiber.join(closing)
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGKILL' })
    }),
  )
})

it.layer(SupervisorLive)('Supervisor abort signal', (suite) => {
  suite.effect('runs the kill ladder when the abort signal fires', () =>
    Effect.gen(function* abortsProcess() {
      const supervisor = yield* Supervisor
      const controller = new AbortController()
      const child = yield* supervisor.spawn(nodeSpec(IDLE, { signal: controller.signal }))
      yield* awaitReady(child)
      controller.abort()
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGINT' })
    }),
  )

  suite.effect('runs the kill ladder at once for a signal that has already aborted', () =>
    Effect.gen(function* abortsAtStart() {
      const supervisor = yield* Supervisor
      const child = yield* supervisor.spawn(nodeSpec(IDLE, { signal: AbortSignal.abort() }))
      assert.deepStrictEqual(yield* child.exit, { code: null, signal: 'SIGINT' })
    }),
  )

  suite.effect('leaves a process that has already exited alone when the signal fires later', () =>
    Effect.gen(function* abortsAfterExit() {
      const supervisor = yield* Supervisor
      const controller = new AbortController()
      const child = yield* supervisor.spawn(nodeSpec('0', { signal: controller.signal }))
      assert.deepStrictEqual(yield* child.exit, { code: 0, signal: null })
      controller.abort()
      assert.deepStrictEqual(yield* supervisor.list(), [])
    }),
  )
})

it.layer(SupervisorLive)('Supervisor abort listener', (suite) => {
  suite.effect('stops listening to the abort signal once its scope closes', () =>
    Effect.gen(function* releasesSignal() {
      const supervisor = yield* Supervisor
      const controller = new AbortController()
      const scope = yield* ownScope
      const spawning = supervisor
        .spawn(nodeSpec('0', { signal: controller.signal }))
        .pipe(Effect.provideService(Scope.Scope, scope))
      const child = yield* spawning
      yield* child.exit
      assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 1)
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual(getEventListeners(controller.signal, 'abort').length, 0)
    }),
  )
})
