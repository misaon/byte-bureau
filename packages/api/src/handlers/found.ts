import path from 'node:path'
import {
  profileUsage,
  ProjectRegistry,
  type ProfileService,
  type Project,
  type UsageService,
} from '@bytebureau/kernel'
import type { UsageSnapshotDto } from '@bytebureau/protocol'
import { Effect } from 'effect'
import {
  orProblem,
  problem,
  type ApiCode,
  type ApiProblem,
  type KernelStatus,
} from '../problems.js'

// A lookup that found nothing is a 404 problem with the code of the resource
export const found = <Entity>(
  entity: Entity | undefined,
  code: ApiCode,
  detail: string,
): Effect.Effect<Entity, ApiProblem<404>> =>
  entity === undefined ? Effect.fail(problem(404, code, detail)) : Effect.succeed(entity)

// The daemon would resolve a relative path in its own working directory, which is no directory of the client's
export const absolutePath = (directory: string): Effect.Effect<string, ApiProblem<422>> =>
  path.isAbsolute(directory)
    ? Effect.succeed(directory)
    : Effect.fail(
        problem(
          422,
          'project_path_not_absolute',
          `${directory} is not an absolute path: the daemon cannot tell what it is relative to`,
        ),
      )

// The usage of a profile as the kernel tells it, "default" the nameless login's; the REST API and the RPC socket ask the same way
export const profileUsageOf = (
  id: string,
): Effect.Effect<UsageSnapshotDto, ApiProblem<KernelStatus>, ProfileService | UsageService> =>
  orProblem(profileUsage(id))

// The project, or the 404 problem when nobody holds the id; the REST API and the RPC socket ask the same way
export const projectOf = (
  id: string,
): Effect.Effect<Project, ApiProblem<KernelStatus>, ProjectRegistry> =>
  orProblem(ProjectRegistry.use((registry) => registry.get(id))).pipe(
    Effect.flatMap((project) => found(project, 'not_found', `no project ${id}`)),
  )
