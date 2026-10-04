import type { Scope } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { AskServiceShape } from '../asks/ask-service.js'
import type { ConfigShape } from '../config/config.js'
import type { EventLogShape } from '../events/event-log.js'
import type { PluginHostShape } from '../plugins/plugin-host.js'
import type { ProjectRegistryShape } from '../projects/project-registry.js'
import type { UsageServiceShape } from '../usage/usage-service.js'
import type { WorkspaceManagerShape } from '../workspace/workspace-manager.js'
import type { KernelInstance, LiveSessions } from './live-sessions.js'

// The environment of the kernel: what configuration reads its BYTEBUREAU_* overrides from
export type KernelEnv = Readonly<Record<string, string | undefined>>

// The services the session manager works with, and what it keeps of the sessions that are running
export interface SessionDeps {
  readonly sql: SqlClient.SqlClient
  readonly log: EventLogShape
  readonly asks: AskServiceShape
  readonly workspaces: WorkspaceManagerShape
  readonly usage: UsageServiceShape
  readonly host: PluginHostShape
  readonly projects: ProjectRegistryShape
  readonly config: ConfigShape
  readonly env: KernelEnv
  readonly live: LiveSessions
  // A session this kernel registers, resumes or prompts is recorded as its own, so the recovery of another kernel leaves it alone
  readonly instance: KernelInstance
  // The fibers of the sessions (the pumps of provider events, the prompts on their way) live in a scope of their own: as long as the layer, not as long as the call that started them
  // The layer closes it once the provider sessions are closed, so a pump that waits for its provider cannot hold the closing of the agents
  readonly scope: Scope.Closeable
}
