import { Effect } from 'effect'

// The kernel's LogTape bridge files a log line under its category annotation; the API's own lines go to bb.api
const underApi = Effect.annotateLogs('category', 'bb.api')

export const logApiError = (...parts: readonly unknown[]): Effect.Effect<void> =>
  underApi(Effect.logError(...parts))

export const logApiWarning = (...parts: readonly unknown[]): Effect.Effect<void> =>
  underApi(Effect.logWarning(...parts))

export const logApiDebug = (...parts: readonly unknown[]): Effect.Effect<void> =>
  underApi(Effect.logDebug(...parts))
