import {
  AddProfileBody,
  ProfileDto,
  ProfileIdParam,
  ProfileStatusDto,
  RemoveProfileQuery,
} from '@bytebureau/protocol'
import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/http-api'
import { Authorization } from '../auth.js'
import { PROBLEM_SCHEMAS } from '../problems.js'
import { MutationLimit } from '../rate-limit.js'
import { RequestValidation } from '../validation.js'

// The status is an annotation, and an annotated schema is a copy of its own; a suspended one keeps naming the one component of the OpenAPI document
const Created = Schema.suspend(() => ProfileDto).pipe(HttpApiSchema.status(201))

// A profile id is <provider>/<name>: it travels as one path segment, percent-encoded
export const ProfilesGroup = HttpApiGroup.make('profiles')
  .add(
    HttpApiEndpoint.get('list', '/profiles', {
      success: Schema.Array(ProfileDto),
      error: PROBLEM_SCHEMAS,
    }),
    HttpApiEndpoint.post('add', '/profiles', {
      payload: AddProfileBody,
      success: Created,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.delete('remove', '/profiles/:id', {
      params: ProfileIdParam,
      query: RemoveProfileQuery,
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.post('setDefault', '/profiles/:id/default', {
      params: ProfileIdParam,
      success: HttpApiSchema.NoContent,
      error: PROBLEM_SCHEMAS,
    }).middleware(MutationLimit),
    HttpApiEndpoint.get('status', '/profiles/:id/status', {
      params: ProfileIdParam,
      success: ProfileStatusDto,
      error: PROBLEM_SCHEMAS,
    }),
  )
  .middleware(Authorization)
  .middleware(RequestValidation)
