import type { LogRecord } from '@logtape/logtape'
import { assert, describe, expect, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { KernelLayer, KernelTest } from './kernel-live.js'
import { configureLogging, resetLogging, type KernelLogLevel } from './logging/logging.js'
import { SessionManager } from './sessions/session-manager.js'
import { StoreTest } from './store/store-test.js'
import { tempDir } from './testing/temp-repo.js'

// A debug and an info record logged by Effect inside the kernel layer; LogTape itself lets both through
async function loggedInKernel(logLevel?: KernelLogLevel): Promise<readonly unknown[]> {
  const seen: LogRecord[] = []
  await configureLogging({
    level: 'debug',
    json: true,
    capture: (record) => {
      seen.push(record)
    },
  })
  try {
    const logging = Effect.andThen(Effect.logDebug('debug'), Effect.logInfo('info'))
    const kernel = KernelTest({ home: tempDir('bb-home-'), logLevel })
    await Effect.runPromise(Effect.provide(logging, kernel))
  } finally {
    await resetLogging()
  }
  return seen.map((record) => record.message[0])
}

describe(KernelTest, () => {
  it('lets Effect log from info up unless the options give a level', async () => {
    expect.hasAssertions()
    await expect(loggedInKernel()).resolves.toStrictEqual(['info'])
  })

  it('lets the debug records of Effect reach the logger when the level is debug', async () => {
    expect.hasAssertions()
    await expect(loggedInKernel('debug')).resolves.toStrictEqual(['debug', 'info'])
  })
})

describe(KernelLayer, () => {
  it.effect('is the whole kernel but the store, which the caller provides', () => {
    const layer = KernelLayer({ home: tempDir('bb-home-') }).pipe(Layer.provideMerge(StoreTest))
    return Effect.gen(function* providesStore() {
      const sessions = yield* SessionManager
      assert.deepStrictEqual(yield* sessions.list(), [])
    }).pipe(Effect.provide(layer))
  })
})
