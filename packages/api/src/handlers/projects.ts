import { ProjectRegistry } from '@bytebureau/kernel'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { BureauApi } from '../api.js'
import { orProblem } from '../problems.js'
import { absolutePath, projectOf } from './found.js'

export const ProjectsHandlers = HttpApiBuilder.group(BureauApi, 'projects', (handlers) =>
  handlers
    .handle('list', () => orProblem(ProjectRegistry.use((registry) => registry.list())))
    .handle('register', ({ payload }) =>
      absolutePath(payload.path).pipe(
        Effect.flatMap((directory) =>
          orProblem(ProjectRegistry.use((registry) => registry.register(directory))),
        ),
      ),
    )
    .handle('get', ({ params }) => projectOf(params.id))
    .handle('remove', ({ params }) =>
      projectOf(params.id).pipe(
        Effect.flatMap(() =>
          orProblem(ProjectRegistry.use((registry) => registry.remove(params.id))),
        ),
      ),
    ),
)
