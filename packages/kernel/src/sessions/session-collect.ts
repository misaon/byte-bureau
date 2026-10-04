import { Effect, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { AskService } from '../asks/ask-service.js'
import { Config } from '../config/config.js'
import { EventLog } from '../events/event-log.js'
import { PluginHost } from '../plugins/plugin-host.js'
import { ProjectRegistry } from '../projects/project-registry.js'
import { UsageService } from '../usage/usage-service.js'
import { WorkspaceManager } from '../workspace/workspace-manager.js'
import type { SessionDeps } from './session-deps.js'

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

// The services the session manager works with, and a scope of its own for the fibers it forks
export type CollectedDeps = Omit<SessionDeps, 'env' | 'live' | 'instance'>

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
      scope: yield* Scope.make('parallel'),
    }
  },
)
