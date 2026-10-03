import { Effect, ManagedRuntime, type Layer } from 'effect'
import { configApi } from './facade/config.js'
import { eventsApi } from './facade/events.js'
import { loadPlugins, providersApi } from './facade/plugins.js'
import { projectsApi } from './facade/projects.js'
import { promisedBy, type Services } from './facade/promised.js'
import { asksApi, sessionsApi, usageApi } from './facade/sessions.js'
import type { Kernel, KernelOptions } from './facade/types.js'
import { workspacesApi } from './facade/workspaces.js'
import { configureLogging, parseLogLevel } from './logging/logging.js'

export type { Kernel, KernelOptions } from './facade/types.js'

// A kernel over a layer that brings its own store, with its plugins loaded
export async function createKernelFrom(
  layer: Layer.Layer<Services>,
  options: KernelOptions,
): Promise<Kernel> {
  const { level, json, debug } = options.logging ?? {}
  await configureLogging({
    level: parseLogLevel(level),
    json: json ?? !process.stdout.isTTY,
    debug,
  })
  const runtime = ManagedRuntime.make(layer)
  const promised = promisedBy(runtime)
  // Captured once, so that an event stream can run outside the runtime
  const services = await runtime.runPromise(Effect.context<Services>())
  await loadPlugins(promised)
  return {
    projects: projectsApi(promised),
    config: configApi(promised, services, options.env),
    sessions: sessionsApi(promised),
    asks: asksApi(promised),
    events: eventsApi(promised, services),
    workspaces: workspacesApi(promised),
    usage: usageApi(promised),
    providers: providersApi(services),
    close: async () => {
      await runtime.dispose()
    },
  }
}
