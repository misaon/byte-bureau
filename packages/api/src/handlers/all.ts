import { Layer } from 'effect'
import { HealthHandlers } from './health.js'
import { SchemasHandlers } from './schemas.js'

// The handler layers of every group; Tasks 4–6 add theirs here
export const Handlers = Layer.mergeAll(HealthHandlers, SchemasHandlers)
