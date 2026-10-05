import { configApi } from './config.js'
import { eventsApi } from './events.js'
import { healthApi } from './health.js'
import { pluginsApi, providersApi } from './plugins.js'
import { profilesApi } from './profiles.js'
import { projectsApi } from './projects.js'
import type { Captured, Promised } from './promised.js'
import { asksApi, sessionsApi, usageApi } from './sessions.js'
import type { Kernel, KernelOptions } from './types.js'
import { workspacesApi } from './workspaces.js'

// Every area of the facade: the calls go through the runtime, what is read without a promise comes from the captured services
export const apisOf = (
  promised: Promised,
  services: Captured,
  env: KernelOptions['env'],
): Omit<Kernel, 'close'> => ({
  projects: projectsApi(promised),
  config: configApi(promised, services, env),
  sessions: sessionsApi(promised),
  asks: asksApi(promised),
  events: eventsApi(promised, services),
  workspaces: workspacesApi(promised),
  usage: usageApi(promised, services),
  providers: providersApi(services),
  profiles: profilesApi(promised),
  plugins: pluginsApi(services),
  health: healthApi(promised),
})
