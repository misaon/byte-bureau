import { Schema, SchemaTransformation } from 'effect'
import { AskAnswer } from '../ask.js'
import { Id, ProfileKind } from '../common.js'
import { PromptInput } from '../employee.js'

export const RegisterProjectBody = Schema.Struct({ path: Schema.String }).annotate({
  title: 'RegisterProject',
  identifier: 'RegisterProject',
})

// The same fields as the kernel's CreateSessionInput; env carries BYTEBUREAU_* names only, the kernel drops the rest and its own (home, log level, workspace runtime)
export const CreateSessionBody = Schema.Struct({
  projectId: Id,
  title: Schema.String,
  employeeId: Schema.optionalKey(Schema.String),
  providerId: Schema.optionalKey(Schema.String),
  profileId: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
}).annotate({ title: 'CreateSession', identifier: 'CreateSession' })

export const PromptBody = PromptInput
export const AnswerAskBody = AskAnswer

export const SessionRef = Schema.Struct({ sessionId: Id }).annotate({
  title: 'SessionRef',
  identifier: 'SessionRef',
})

// The text of a seq in a query string: digits only, which the OpenAPI document tells in the pattern
// No sign, fraction or exponent goes through, so a client knows the bound from the document itself
const SeqText = Schema.String.check(Schema.isPattern(/^\d+$/u)).annotate({
  description: 'The last seq the client has seen: a whole number of 0 or more',
})

const SeqFromText = SeqText.pipe(
  Schema.decodeTo(Schema.Natural, SchemaTransformation.numberFromString),
)

// The query string of GET /events: types is comma-separated, since is the last seq the client has seen (0 or more)
export const EventsQuery = Schema.Struct({
  since: Schema.optionalKey(SeqFromText),
  session: Schema.optionalKey(Id),
  project: Schema.optionalKey(Id),
  types: Schema.optionalKey(Schema.String),
}).annotate({ title: 'EventsQuery', identifier: 'EventsQuery' })

// The filter of the RPC subscription, the shape of the kernel's EventFilter
export const EventsFilter = Schema.Struct({
  since: Schema.optionalKey(Schema.Natural),
  sessionId: Schema.optionalKey(Id),
  projectId: Schema.optionalKey(Id),
  types: Schema.optionalKey(Schema.Array(Schema.String)),
  ephemeral: Schema.optionalKey(Schema.Boolean),
}).annotate({ title: 'EventsFilter', identifier: 'EventsFilter' })

// A profile name is a path segment of the profiles directory: lower-case letters, digits and dashes, 1 to 32 of them
const ProfileName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/u)).annotate({
  title: 'ProfileName',
  description: 'Lower-case letters, digits and dashes, 1 to 32 characters',
})

export const AddProfileBody = Schema.Struct({
  providerId: Schema.String,
  name: ProfileName,
  kind: ProfileKind,
  // Only for kind api_key; stored in the secret store, never echoed
  apiKey: Schema.optionalKey(Schema.String),
  makeDefault: Schema.optionalKey(Schema.Boolean),
}).annotate({ title: 'AddProfile', identifier: 'AddProfile' })

export const ProfileIdParam = Schema.Struct({ id: Schema.String })

// A query string carries purge as text, which the handler reads as a boolean
export const RemoveProfileQuery = Schema.Struct({
  purge: Schema.optionalKey(Schema.Literals(['true', 'false'])),
})

export type RegisterProjectBody = typeof RegisterProjectBody.Type
export type CreateSessionBody = typeof CreateSessionBody.Type
export type PromptBody = typeof PromptBody.Type
export type AnswerAskBody = typeof AnswerAskBody.Type
export type SessionRef = typeof SessionRef.Type
export type EventsQuery = typeof EventsQuery.Type
export type EventsFilter = typeof EventsFilter.Type
export type AddProfileBody = typeof AddProfileBody.Type
