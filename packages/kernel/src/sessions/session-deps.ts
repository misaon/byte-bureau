import type { Scope } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { AskServiceShape } from '../asks/ask-service.js'
import type { EventLogShape } from '../events/event-log.js'
import { kernelLogger } from '../logging/logging.js'
import type { PluginHostShape } from '../plugins/plugin-host.js'
import type { ProjectRegistryShape } from '../projects/project-registry.js'
import type { UsageServiceShape } from '../usage/usage-service.js'
import type { WorkspaceManagerShape } from '../workspace/workspace-manager.js'
import type { LiveSessions } from './live-sessions.js'

export const logger = kernelLogger(['bb', 'core', 'sessions'])

// The services the session manager works with, and what it keeps of the sessions that are running
export interface SessionDeps {
  readonly sql: SqlClient.SqlClient
  readonly log: EventLogShape
  readonly asks: AskServiceShape
  readonly workspaces: WorkspaceManagerShape
  readonly usage: UsageServiceShape
  readonly host: PluginHostShape
  readonly projects: ProjectRegistryShape
  readonly live: LiveSessions
  // The fibers that pump provider events live as long as the layer, not as long as the call that started them
  readonly scope: Scope.Scope
}
