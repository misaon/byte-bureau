import { AnswerAskBody, AskRecord, Id } from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { PROBLEM_SCHEMAS } from '../problems.js'
import { MutationLimit } from '../rate-limit.js'
import { RequestValidation } from '../validation.js'

export const AsksGroup = HttpApiGroup.make('asks')
  .add(
    HttpApiEndpoint.get('pending', '/asks', {
      query: { session: Schema.optionalKey(Id) },
      success: Schema.Array(AskRecord),
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.get('get', '/asks/:id', {
      params: { id: Id },
      success: AskRecord,
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.post('answer', '/asks/:id/answer', {
      params: { id: Id },
      payload: AnswerAskBody,
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
