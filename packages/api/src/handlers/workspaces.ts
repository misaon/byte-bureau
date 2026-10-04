import { WorkspaceManager } from '@bytebureau/kernel'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem } from '../problems.js'

export const WorkspacesHandlers = HttpApiBuilder.group(BureauApi, 'workspaces', (handlers) =>
  handlers
    .handle('list', ({ query }) =>
      orProblem(WorkspaceManager.use((workspaces) => workspaces.list(query.project))),
    )
    .handle('prune', ({ payload }) =>
      orProblem(WorkspaceManager.use((workspaces) => workspaces.prune(payload.projectId))),
    ),
)
