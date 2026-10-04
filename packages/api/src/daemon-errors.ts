import { Cause, ErrorReporter, type Layer } from 'effect'
import { HttpServerError } from 'effect/http'
import type { BoundAddress } from './bun-address.js'

export class PortInUseError extends Error {
  public override readonly name = 'PortInUseError'
}

const hostPort = ({ host, port }: BoundAddress): string =>
  host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`

// Bun.serve throws when it cannot bind, so the start fails with that defect rather than a ServeError: one line for the CLI to print
// Bun says EADDRINUSE for an address this machine does not have as well, so the line keeps both readings
export const portInUse = (error: unknown, address: BoundAddress): PortInUseError | undefined =>
  error instanceof Error &&
  (Reflect.get(error, 'code') === 'EADDRINUSE' || error.message.includes('Is port'))
    ? new PortInUseError(
        `cannot listen on ${hostPort(address)}: the port is taken or the address is not this machine's`,
        { cause: error },
      )
    : undefined

export type DefectLog = (message: string, properties: Readonly<Record<string, unknown>>) => void

// A body the server could not read, such as one over Bun's size limit that came without a length, is the client's fault: Bun answers it 413
const isClientFault = (defect: unknown): boolean =>
  HttpServerError.isHttpServerError(defect) &&
  defect.reason instanceof HttpServerError.RequestParseError

const daemonDefects = (cause: Cause.Cause<unknown>): readonly unknown[] =>
  cause.reasons
    .filter(Cause.isDieReason)
    .map((reason) => reason.defect)
    .filter((defect) => !isClientFault(defect))

// Every failure behind either door is reported, the problems the API answers on purpose too, so only a cause with a defect of the daemon is logged
// Such a defect is otherwise silent: a REST handler answers an empty 500, an RPC procedure an Exit with a Die
export const DefectReporter = (log: DefectLog): Layer.Layer<never> =>
  ErrorReporter.layer([
    ErrorReporter.make(({ cause, error }) => {
      if (daemonDefects(cause).length > 0) {
        log('a handler failed with a defect', { error: error.message, cause: Cause.pretty(cause) })
      }
    }),
  ])
