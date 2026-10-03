import { Layer } from 'effect'
import type { SqlClient } from 'effect/sql'
import { ConfigLive, type Config } from './config/config.js'
import { EventLogLive, type EventLog } from './events/event-log.js'
import { EffectLoggerLive, EffectLogLevelLive, type KernelLogLevel } from './logging/logging.js'
import { SupervisorLive, type Supervisor } from './process/supervisor.js'
import { UsageServiceLive, type UsageService } from './usage/usage-service.js'

export interface FoundationOptions {
  readonly home: string
  // Effect drops its own logs below this level; info when absent
  readonly logLevel?: KernelLogLevel | undefined
}

export type FoundationServices = Config | EventLog | Supervisor | UsageService

export type UsageLayer = Layer.Layer<UsageService, never, SqlClient.SqlClient>

// What the other services stand on; these need nothing of each other
// The usage service is the live one unless a test swaps its own in
export const FoundationLive = (
  options: FoundationOptions,
  usage: UsageLayer = UsageServiceLive,
): Layer.Layer<FoundationServices, never, SqlClient.SqlClient> =>
  Layer.mergeAll(
    ConfigLive(options.home),
    EventLogLive,
    SupervisorLive,
    usage,
    EffectLoggerLive,
    EffectLogLevelLive(options.logLevel ?? 'info'),
  )
