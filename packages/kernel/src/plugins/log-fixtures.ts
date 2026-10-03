import type { LogRecord } from '@logtape/logtape'
import { Effect, type Scope } from 'effect'
import { vi } from 'vitest'
import { configureLogging, resetLogging } from '../logging/logging.js'

// LogTape is global: the warnings of the test are collected until its scope closes, and kept off the console
export const warnings: Effect.Effect<readonly LogRecord[], never, Scope.Scope> = Effect.map(
  Effect.acquireRelease(
    Effect.promise(async () => {
      const records: LogRecord[] = []
      const spy = vi.spyOn(globalThis.console, 'warn').mockReturnValue()
      await configureLogging({
        level: 'warn',
        json: true,
        capture: (record) => {
          records.push(record)
        },
      })
      return { records, spy }
    }),
    ({ spy }) =>
      Effect.promise(async () => {
        await resetLogging()
        spy.mockRestore()
      }),
  ),
  ({ records }) => records,
)
