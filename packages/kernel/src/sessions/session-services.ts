import type { SqlClient } from 'effect/sql'
import type { AskService } from '../asks/ask-service.js'
import type { Config } from '../config/config.js'
import type { EventLog } from '../events/event-log.js'
import type { PluginHost } from '../plugins/plugin-host.js'
import type { ProjectRegistry } from '../projects/project-registry.js'
import type { UsageService } from '../usage/usage-service.js'
import type { WorkspaceRuntimes } from '../workspace/runtimes.js'
import type { WorkspaceManager } from '../workspace/workspace-manager.js'
import type { SessionManager } from './session-manager.js'

// Everything a test of the sessions can ask the layer for
export type SessionServices =
  | SessionManager
  | AskService
  | UsageService
  | WorkspaceManager
  | WorkspaceRuntimes
  | PluginHost
  | ProjectRegistry
  | Config
  | EventLog
  | SqlClient.SqlClient
