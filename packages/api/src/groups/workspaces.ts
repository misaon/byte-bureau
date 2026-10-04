import { Id, PruneReportDto, WorkspaceInfoDto } from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { PROBLEM_SCHEMAS } from '../problems.js'
import { MutationLimit } from '../rate-limit.js'
import { RequestValidation } from '../validation.js'

const PruneBody = Schema.Struct({ projectId: Schema.optionalKey(Id) }).annotate({
  title: 'PruneWorkspaces',
  identifier: 'PruneWorkspaces',
})

export const WorkspacesGroup = HttpApiGroup.make('workspaces')
  .add(
    HttpApiEndpoint.get('list', '/workspaces', {
      query: { project: Schema.optionalKey(Id) },
      success: Schema.Array(WorkspaceInfoDto),
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.post('prune', '/workspaces/prune', {
      payload: PruneBody,
      success: PruneReportDto,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
