import { WorkspaceManager } from '../workspace/workspace-manager.js'
import type { Promised } from './promised.js'
import type { Kernel } from './types.js'

export const workspacesApi = (promised: Promised): Kernel['workspaces'] => ({
  list: promised(WorkspaceManager, (workspaces, projectId) => workspaces.list(projectId)),
  prune: promised(WorkspaceManager, (workspaces, projectId) => workspaces.prune(projectId)),
})
