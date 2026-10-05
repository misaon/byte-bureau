import { Layer } from 'effect'
import { AsksHandlers } from './asks.js'
import { ProfilesHandlers } from './profiles.js'
import { ProjectsHandlers } from './projects.js'
import { SessionsHandlers } from './sessions.js'
import { UsageHandlers } from './usage.js'
import { WorkspacesHandlers } from './workspaces.js'

// The handler layers of the groups in RESOURCE_GROUPS
export const ResourceHandlers = Layer.mergeAll(
  ProjectsHandlers,
  ProfilesHandlers,
  SessionsHandlers,
  AsksHandlers,
  UsageHandlers,
  WorkspacesHandlers,
)
