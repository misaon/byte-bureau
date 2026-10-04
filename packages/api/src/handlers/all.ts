import { Layer } from 'effect'
import { AsksHandlers } from './asks.js'
import { HealthHandlers } from './health.js'
import { PluginsHandlers } from './plugins.js'
import { ProjectsHandlers } from './projects.js'
import { SchemasHandlers } from './schemas.js'
import { SessionsHandlers } from './sessions.js'
import { UsageHandlers } from './usage.js'
import { WorkspacesHandlers } from './workspaces.js'

// The handler layers of every group
export const Handlers = Layer.mergeAll(
  HealthHandlers,
  SchemasHandlers,
  ProjectsHandlers,
  SessionsHandlers,
  AsksHandlers,
  UsageHandlers,
  WorkspacesHandlers,
  PluginsHandlers,
)
