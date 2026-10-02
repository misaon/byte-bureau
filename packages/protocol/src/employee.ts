import { Schema } from 'effect'
import { Effort, PermissionMode } from './common.js'

export const Appearance = Schema.Struct({
  gender: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  hair: Schema.optionalKey(Schema.String),
  outfit: Schema.optionalKey(Schema.String),
  palette: Schema.optionalKey(Schema.String),
})

export const ToolPolicy = Schema.Struct({
  allow: Schema.Array(Schema.String),
  deny: Schema.Array(Schema.String),
})

export const EmployeeSpec = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Effort),
  systemPrompt: Schema.String,
  tools: ToolPolicy,
  permissionMode: PermissionMode,
  skills: Schema.Array(Schema.String),
  maxTurns: Schema.optionalKey(Schema.Number),
  askTimeout: Schema.optionalKey(Schema.String),
  appearance: Appearance,
})

export const Attachment = Schema.Struct({
  path: Schema.String,
  mime: Schema.optionalKey(Schema.String),
})
export const PromptInput = Schema.Struct({
  text: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
})

export type Appearance = typeof Appearance.Type
export type ToolPolicy = typeof ToolPolicy.Type
export type EmployeeSpec = typeof EmployeeSpec.Type
export type Attachment = typeof Attachment.Type
export type PromptInput = typeof PromptInput.Type
