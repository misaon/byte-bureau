import { AsksGroup } from './asks.js'
import { ProfilesGroup } from './profiles.js'
import { ProjectsGroup } from './projects.js'
import { SessionsGroup } from './sessions.js'
import { UsageGroup } from './usage.js'
import { WorkspacesGroup } from './workspaces.js'

// The groups of what the daemon keeps: projects, profiles, sessions, asks, their usage and their worktrees
export const RESOURCE_GROUPS = [
  ProjectsGroup,
  ProfilesGroup,
  SessionsGroup,
  AsksGroup,
  UsageGroup,
  WorkspacesGroup,
] as const
