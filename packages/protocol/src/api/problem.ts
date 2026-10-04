import { Schema } from 'effect'

export const PROBLEM_TYPE_BASE = 'https://bytebureau.dev/problems/'

// The well-known codes; the API also forms workspace_<code> and provider_<kind> from the kernel's errors
export const PROBLEM_CODES = [
  'request_invalid',
  'unauthorized',
  'forbidden',
  'not_found',
  'payload_too_large',
  'rate_limited',
  'internal',
  'config_invalid',
  'store_unavailable',
  'plugin_failed',
  'session_not_found',
  'session_invalid_transition',
  'session_provider_missing',
  'session_yolo_refused',
  'session_employee_missing',
  'ask_not_found',
  'ask_not_pending',
  'ask_invalid_answer',
  'provider_auth',
  'provider_ratelimit',
  'provider_crash',
  'provider_protocol',
  'provider_missing',
  'workspace_dirty',
  'workspace_locked',
  'workspace_has_sessions',
  'workspace_not_a_repository',
  'workspace_is_bytebureau_worktree',
  'workspace_git_too_old',
  'workspace_git_failed',
  'workspace_fs_failed',
  'workspace_runtime_missing',
] as const

export type ProblemCode = (typeof PROBLEM_CODES)[number]

export const problemType = (code: string): string => `${PROBLEM_TYPE_BASE}${code}`

// RFC 9457 problem details; code is a ByteBureau error code and type is derived from it
export const Problem = Schema.Struct({
  type: Schema.String,
  title: Schema.String,
  status: Schema.Int,
  detail: Schema.String,
  code: Schema.String,
  instance: Schema.optionalKey(Schema.String),
}).annotate({
  title: 'Problem',
  description: 'RFC 9457 problem details with a ByteBureau error code',
})

export type Problem = typeof Problem.Type
