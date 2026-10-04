import { AskService } from '@bytebureau/kernel'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem } from '../problems.js'
import { found } from './found.js'

export const AsksHandlers = HttpApiBuilder.group(BureauApi, 'asks', (handlers) =>
  handlers
    .handle('pending', ({ query }) =>
      orProblem(AskService.use((asks) => asks.pending(query.session))),
    )
    .handle('get', ({ params }) =>
      orProblem(AskService.use((asks) => asks.get(params.id))).pipe(
        Effect.flatMap((ask) => found(ask, 'ask_not_found', `no ask ${params.id}`)),
      ),
    )
    .handle('answer', ({ params, payload }) =>
      orProblem(AskService.use((asks) => asks.answer(params.id, payload, 'api'))).pipe(
        Effect.asVoid,
      ),
    ),
)
