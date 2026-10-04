import { ProjectRegistry, type Project } from '@bytebureau/kernel'
import { Effect } from 'effect'
import { orProblem, problem, type ApiProblem, type KernelStatus } from '../problems.js'

// A lookup that found nothing is a 404 problem with the code of the resource
export const found = <Entity>(
  entity: Entity | undefined,
  code: string,
  detail: string,
): Effect.Effect<Entity, ApiProblem<404>> =>
  entity === undefined ? Effect.fail(problem(404, code, detail)) : Effect.succeed(entity)

// The project, or the 404 problem when nobody holds the id; the REST API and the RPC socket ask the same way
export const projectOf = (
  id: string,
): Effect.Effect<Project, ApiProblem<KernelStatus>, ProjectRegistry> =>
  orProblem(ProjectRegistry.use((registry) => registry.get(id))).pipe(
    Effect.flatMap((project) => found(project, 'not_found', `no project ${id}`)),
  )
