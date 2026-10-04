import { Cause, ErrorReporter, type Layer } from 'effect'

export class PortInUseError extends Error {
  public override readonly name = 'PortInUseError'
}

// Bun.serve throws when the port is taken, so the start fails with that defect rather than a ServeError: one line for the CLI to print
export const portInUse = (error: unknown, port: number): PortInUseError | undefined =>
  error instanceof Error &&
  (Reflect.get(error, 'code') === 'EADDRINUSE' || error.message.includes('Is port'))
    ? new PortInUseError(`port ${port} is already in use`, { cause: error })
    : undefined

export type DefectLog = (message: string, properties: Readonly<Record<string, unknown>>) => void

// Every failure behind either door is reported, the problems the API answers on purpose too, so only a cause with a defect is logged
// Such a defect is otherwise silent: a REST handler answers an empty 500, an RPC procedure an Exit with a Die
export const DefectReporter = (log: DefectLog): Layer.Layer<never> =>
  ErrorReporter.layer([
    ErrorReporter.make(({ cause, error }) => {
      if (Cause.hasDies(cause)) {
        log('a handler failed with a defect', { error: error.message, cause: Cause.pretty(cause) })
      }
    }),
  ])
