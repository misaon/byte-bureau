import type { Context, Effect, ManagedRuntime } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { KernelServices } from '../kernel-live.js'

// Everything a kernel layer offers, the store included
export type Services = KernelServices | SqlClient.SqlClient

export type Runtime = ManagedRuntime.ManagedRuntime<Services, never>

// A call of a service as a function that returns a promise
export type Promised = <Id extends Services, Shape, Args extends readonly unknown[], Value>(
  service: Context.Service<Id, Shape>,
  call: (shape: Shape, ...args: Args) => Effect.Effect<Value, unknown>,
) => (...args: Args) => Promise<Value>

// A runtime that is disposed rejects with a bare string; a caller always gets an Error
export const promisedBy =
  (runtime: Runtime): Promised =>
  (service, call) =>
  async (...args) => {
    try {
      return await runtime.runPromise(service.use((shape) => call(shape, ...args)))
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }
  }
