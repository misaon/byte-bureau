import { SessionManager, type SessionManagerShape } from '@bytebureau/kernel'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem, type ApiProblem, type KernelStatus } from '../problems.js'
import { found } from './found.js'

const sessions = <Value, Failure>(
  call: (manager: SessionManagerShape) => Effect.Effect<Value, Failure>,
): Effect.Effect<Value, ApiProblem<KernelStatus>, SessionManager> =>
  orProblem(SessionManager.use(call))

export const SessionsHandlers = HttpApiBuilder.group(BureauApi, 'sessions', (handlers) =>
  handlers
    .handle('list', () => sessions((manager) => manager.list()))
    .handle('create', ({ payload }) => sessions((manager) => manager.create(payload)))
    .handle('get', ({ params }) =>
      sessions((manager) => manager.get(params.id)).pipe(
        Effect.flatMap((session) => found(session, 'session_not_found', `no session ${params.id}`)),
      ),
    )
    .handle('prompt', ({ params, payload }) =>
      sessions((manager) => manager.prompt(params.id, payload)),
    )
    .handle('interrupt', ({ params }) => sessions((manager) => manager.interrupt(params.id)))
    .handle('stop', ({ params }) => sessions((manager) => manager.stop(params.id)))
    .handle('resume', ({ params }) => sessions((manager) => manager.resume(params.id)))
    .handle('complete', ({ params }) => sessions((manager) => manager.complete(params.id))),
)
