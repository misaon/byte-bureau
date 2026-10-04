import { CreateSessionBody, Id, PromptBody, SessionDto, TurnDto } from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { PROBLEM_SCHEMAS } from '../problems.js'
import { MutationLimit } from '../rate-limit.js'
import { RequestValidation } from '../validation.js'

const byId = { id: Id }

// The status is an annotation, and an annotated schema is a copy of its own; a suspended one keeps naming the one component of the OpenAPI document
const Created = Schema.suspend(() => SessionDto).pipe(HttpApiSchema.status(201))

export const SessionsGroup = HttpApiGroup.make('sessions')
  .add(
    HttpApiEndpoint.get('list', '/sessions', {
      success: Schema.Array(SessionDto),
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.post('create', '/sessions', {
      payload: CreateSessionBody,
      success: Created,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.get('get', '/sessions/:id', {
      params: byId,
      success: SessionDto,
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.post('prompt', '/sessions/:id/prompt', {
      params: byId,
      payload: PromptBody,
      success: TurnDto,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.post('interrupt', '/sessions/:id/interrupt', {
      params: byId,
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.post('stop', '/sessions/:id/stop', {
      params: byId,
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.post('resume', '/sessions/:id/resume', {
      params: byId,
      success: SessionDto,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.post('complete', '/sessions/:id/complete', {
      params: byId,
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
