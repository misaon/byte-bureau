import { Effect, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { AskService } from '../asks/ask-service.js'
import { EventLog } from '../events/event-log.js'
import { PluginHost } from '../plugins/plugin-host.js'
import { ProjectRegistry } from '../projects/project-registry.js'
import { UsageService } from '../usage/usage-service.js'
import { WorkspaceManager } from '../workspace/workspace-manager.js'
import { LiveSessions } from './live-sessions.js'
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

// The services the session manager works with, a scope of its own for the fibers it forks and an empty record of running sessions
export const collectDeps: Effect.Effect<SessionDeps, never, SessionRequirements> = Effect.gen(
  function* collectsDeps() {
    return {
      sql: yield* SqlClient.SqlClient,
      log: yield* EventLog,
      asks: yield* AskService,
      workspaces: yield* WorkspaceManager,
      usage: yield* UsageService,
      host: yield* PluginHost,
      projects: yield* ProjectRegistry,
      live: new LiveSessions(),
      scope: yield* Scope.make('parallel'),
    }
  },
)
