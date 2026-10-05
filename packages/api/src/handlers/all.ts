import { Layer } from 'effect'
import { EventsHandlers } from './events.js'
import { HealthHandlers } from './health.js'
import { PluginsHandlers } from './plugins.js'
import { ResourceHandlers } from './resources.js'
import { SchemasHandlers } from './schemas.js'

// The handler layers of every group
export const Handlers = Layer.mergeAll(
  HealthHandlers,
  SchemasHandlers,
  ResourceHandlers,
  PluginsHandlers,
  EventsHandlers,
)
