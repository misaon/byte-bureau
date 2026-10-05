import { SessionManager, UsageService } from '@bytebureau/kernel'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem } from '../problems.js'
import { found, profileUsageOf } from './found.js'

// The usage of a session that is not there is not found, not nothing used
export const UsageHandlers = HttpApiBuilder.group(BureauApi, 'usage', (handlers) =>
  handlers
    .handle('session', ({ params }) =>
      orProblem(SessionManager.use((sessions) => sessions.get(params.id))).pipe(
        Effect.flatMap((session) => found(session, 'session_not_found', `no session ${params.id}`)),
        Effect.flatMap(() => orProblem(UsageService.use((usage) => usage.sessionUsage(params.id)))),
      ),
    )
    .handle('profile', ({ params }) => profileUsageOf(params.id)),
)
