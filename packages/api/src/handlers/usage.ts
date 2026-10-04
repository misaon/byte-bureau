import { UsageService } from '@bytebureau/kernel'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem } from '../problems.js'

export const UsageHandlers = HttpApiBuilder.group(BureauApi, 'usage', (handlers) =>
  handlers.handle('session', ({ params }) =>
    orProblem(UsageService.use((usage) => usage.sessionUsage(params.id))),
  ),
)
