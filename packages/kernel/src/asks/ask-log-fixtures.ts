import type { LogRecord } from '@logtape/logtape'
import { Effect, type Scope } from 'effect'
import { vi } from 'vitest'
import { warnings } from '../plugins/log-fixtures.js'

// The warnings fixture keeps console.warn quiet; an error record would reach console.error
const quietErrors: Effect.Effect<void, never, Scope.Scope> = Effect.acquireRelease(
  Effect.sync(() => vi.spyOn(globalThis.console, 'error').mockReturnValue()),
  (spy) =>
    Effect.sync(() => {
      spy.mockRestore()
    }),
).pipe(Effect.asVoid)

// Everything the asks log, errors included, until the scope of the test closes
export const logged: Effect.Effect<readonly LogRecord[], never, Scope.Scope> = Effect.andThen(
  quietErrors,
  warnings,
)
