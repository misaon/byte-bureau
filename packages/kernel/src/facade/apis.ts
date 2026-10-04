import type { Context } from 'effect'
import { configApi } from './config.js'
import { eventsApi } from './events.js'
import { healthApi } from './health.js'
import { pluginsApi, providersApi } from './plugins.js'
import { projectsApi } from './projects.js'
import type { Promised, Services } from './promised.js'
import { asksApi, sessionsApi, usageApi } from './sessions.js'
import type { Kernel, KernelOptions } from './types.js'
import { workspacesApi } from './workspaces.js'

// Every area of the facade: the calls go through the runtime, what is read without a promise comes from the captured services
export const apisOf = (
  promised: Promised,
  services: Context.Context<Services>,
  env: KernelOptions['env'],
): Omit<Kernel, 'close'> => ({
  projects: projectsApi(promised),
  config: configApi(promised, services, env),
  sessions: sessionsApi(promised),
  asks: asksApi(promised),
  events: eventsApi(promised, services),
  workspaces: workspacesApi(promised),
  usage: usageApi(promised),
  providers: providersApi(services),
  plugins: pluginsApi(services),
  health: healthApi(promised),
})
