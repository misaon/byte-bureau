import { Id, ProjectDto, RegisterProjectBody } from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { PROBLEM_SCHEMAS } from '../problems.js'
import { MutationLimit } from '../rate-limit.js'
import { RequestValidation } from '../validation.js'

// The status is an annotation, and an annotated schema is a copy of its own; a suspended one keeps naming the one component of the OpenAPI document
const Created = Schema.suspend(() => ProjectDto).pipe(HttpApiSchema.status(201))

export const ProjectsGroup = HttpApiGroup.make('projects')
  .add(
    HttpApiEndpoint.get('list', '/projects', {
      success: Schema.Array(ProjectDto),
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.post('register', '/projects', {
      payload: RegisterProjectBody,
      success: Created,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.get('get', '/projects/:id', {
      params: { id: Id },
      success: ProjectDto,
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.delete('remove', '/projects/:id', {
      params: { id: Id },
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
