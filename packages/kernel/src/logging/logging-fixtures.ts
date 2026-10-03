import type { LogRecord } from '@logtape/logtape'
import { Effect, Layer, References } from 'effect'
import { vi } from 'vitest'
import { configureLogging, EffectLoggerLive, resetLogging, type LoggingOptions } from './logging.js'

// LogTape's configuration is global: each test configures it, runs its logging, collects the records and resets
export async function captured(
  options: Omit<LoggingOptions, 'capture'>,
  logging: Effect.Effect<void>,
): Promise<readonly LogRecord[]> {
  const seen: LogRecord[] = []
  await configureLogging({
    ...options,
    capture: (entry) => {
      seen.push(entry)
    },
  })
  try {
    const layer = Layer.mergeAll(
      EffectLoggerLive,
      Layer.succeed(References.MinimumLogLevel, 'Debug'),
    )
    await Effect.runPromise(Effect.provide(logging, layer))
  } finally {
    await resetLogging()
  }
  return seen
}

export interface Written {
  readonly stdout: readonly string[]
  readonly stderr: readonly string[]
}

// What the work writes to the two standard streams, which the test holds while it runs
export async function written(work: () => Promise<unknown>): Promise<Written> {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    await work()
    return {
      stdout: stdout.mock.calls.map(([chunk]) => String(chunk)),
      stderr: stderr.mock.calls.map(([chunk]) => String(chunk)),
    }
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }
}
