import { Effect, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { AskService, type AskServiceShape } from '../asks/ask-service.js'
import { Config, type ConfigShape } from '../config/config.js'
import { EventLog, type EventLogShape } from '../events/event-log.js'
import { PluginHost, type PluginHostShape } from '../plugins/plugin-host.js'
import { ProfileService, type ProfileServiceShape } from '../profiles/profile-service.js'
import { ProjectRegistry, type ProjectRegistryShape } from '../projects/project-registry.js'
import { UsageService, type UsageServiceShape } from '../usage/usage-service.js'
import { WorkspaceManager, type WorkspaceManagerShape } from '../workspace/workspace-manager.js'

// The services of the kernel a session works with
export interface SessionServices {
  readonly sql: SqlClient.SqlClient
  readonly log: EventLogShape
  readonly asks: AskServiceShape
  readonly workspaces: WorkspaceManagerShape
  readonly usage: UsageServiceShape
  readonly host: PluginHostShape
  readonly projects: ProjectRegistryShape
  readonly config: ConfigShape
  readonly profiles: ProfileServiceShape
}

// What the session manager needs of the layers around it
export type SessionRequirements =
  | SqlClient.SqlClient
  | EventLog
  | ProjectRegistry
  | WorkspaceManager
  | PluginHost
  | AskService
  | UsageService
  | Config
  | ProfileService

// The services the session manager works with, and a scope of its own for the fibers it forks
export interface CollectedDeps extends SessionServices {
  readonly scope: Scope.Closeable
}

export const collectDeps: Effect.Effect<CollectedDeps, never, SessionRequirements> = Effect.gen(
  function* collectsDeps() {
    return {
      sql: yield* SqlClient.SqlClient,
      log: yield* EventLog,
      asks: yield* AskService,
      workspaces: yield* WorkspaceManager,
      usage: yield* UsageService,
      host: yield* PluginHost,
      projects: yield* ProjectRegistry,
      config: yield* Config,
      profiles: yield* ProfileService,
      scope: yield* Scope.make('parallel'),
    }
  },
)
