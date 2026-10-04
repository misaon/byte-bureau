import { Effect, ManagedRuntime, type Layer } from 'effect'
import { apisOf } from './facade/apis.js'
import { configureKernelLogging } from './facade/boot-logging.js'
import { loadPlugins } from './facade/plugins.js'
import { promisedBy, type Runtime, type Services } from './facade/promised.js'
import type { Kernel, KernelOptions } from './facade/types.js'
import { kernelLogger } from './logging/logging.js'
import { SessionManager } from './sessions/session-manager.js'

export type { Kernel, KernelOptions } from './facade/types.js'

// The steps that can fail while a kernel starts; the sessions a previous process left at work are stopped once the plugins have loaded
async function boot(runtime: Runtime, options: KernelOptions): Promise<Kernel> {
  await configureKernelLogging(options)
  const promised = promisedBy(runtime)
  // Captured once, so that an event stream can run outside the runtime
  const services = await runtime.runPromise(Effect.context<Services>())
  await loadPlugins(promised)
  const recovered = await promised(SessionManager, (sessions) => sessions.recover())()
  if (recovered.length > 0) {
    kernelLogger(['bb', 'core']).info('recovered sessions left by a previous process', {
      sessions: recovered,
    })
  }
  return {
    ...apisOf(promised, services, options.env),
    close: async () => {
      await runtime.dispose()
    },
  }
}

/**
 * A kernel over a layer that brings its own store, with its plugins loaded.
 * The log level (logging.level, else the user file and BYTEBUREAU_LOG_LEVEL) configures LogTape only: Effect drops its own records below the logLevel the layer was built with, which createKernel sets from the same level.
 * A kernel that fails to start is disposed before the failure is passed on, so no handle or fiber stays behind, and the failure of the start is what rejects even when disposing fails as well.
 */
export async function createKernelFrom(
  layer: Layer.Layer<Services>,
  options: KernelOptions,
): Promise<Kernel> {
  const runtime = ManagedRuntime.make(layer)
  try {
    return await boot(runtime, options)
  } catch (error) {
    await Promise.allSettled([runtime.dispose()])
    throw error
  }
}
