import { Schema } from 'effect'

export const Id = Schema.String.annotate({ title: 'UUIDv7', description: 'Time-ordered UUID (v7)' })
export const Timestamp = Schema.String.annotate({ title: 'Timestamp', description: 'ISO-8601 UTC' })

export const SessionStatus = Schema.Literals([
  'created',
  'provisioning',
  'ready',
  'running',
  'waiting_for_human',
  'paused_usage_limit',
  'completed',
  'stopped',
  'errored',
])
export const TurnStatus = Schema.Literals(['running', 'completed', 'interrupted', 'errored'])
export const AskStatus = Schema.Literals(['pending', 'answered', 'expired', 'cancelled'])
export const PermissionMode = Schema.Literals(['supervised', 'autonomous', 'yolo'])
export const Effort = Schema.Literals(['low', 'medium', 'high', 'xhigh', 'max'])
export const AnsweredVia = Schema.Literals(['cli', 'api', 'timeout', 'policy'])
// How a profile signs its provider in: a login of its own, or an API key in the secret store
export const ProfileKind = Schema.Literals(['login', 'api_key'])

export type Id = typeof Id.Type
export type Timestamp = typeof Timestamp.Type
export type SessionStatus = typeof SessionStatus.Type
export type TurnStatus = typeof TurnStatus.Type
export type AskStatus = typeof AskStatus.Type
export type PermissionMode = typeof PermissionMode.Type
export type Effort = typeof Effort.Type
export type AnsweredVia = typeof AnsweredVia.Type
export type ProfileKind = typeof ProfileKind.Type
