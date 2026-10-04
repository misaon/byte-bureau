import { Id, ProfileIdParam, SessionUsageDto, UsageSnapshotDto } from '@bytebureau/protocol'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { PROBLEM_SCHEMAS } from '../problems.js'
import { RequestValidation } from '../validation.js'

export const UsageGroup = HttpApiGroup.make('usage')
  .add(
    HttpApiEndpoint.get('session', '/usage/sessions/:id', {
      params: { id: Id },
      success: SessionUsageDto,
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.get('profile', '/usage/profiles/:id', {
      params: ProfileIdParam,
      success: UsageSnapshotDto,
      error: PROBLEM_SCHEMAS,
    }),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
