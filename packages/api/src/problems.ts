import {
  AskError,
  ConfigError,
  PluginError,
  ProviderError,
  SessionError,
  StoreError,
  WorkspaceError,
} from '@bytebureau/kernel'
import { problemType, type Problem } from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import { HttpApiSchema } from 'effect/http-api'

export const PROBLEM_STATUSES = [400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503] as const
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number]

const TITLES: Readonly<Record<ProblemStatus, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
}

export interface ApiProblem<Status extends ProblemStatus = ProblemStatus> extends Omit<
  Problem,
  'status'
> {
  readonly status: Status
}

type ProblemSchema<Status extends ProblemStatus> = Schema.Struct<{
  readonly type: Schema.String
  readonly title: Schema.String
  readonly status: Schema.Literal<Status>
  readonly detail: Schema.String
  readonly code: Schema.String
  readonly instance: Schema.optionalKey<Schema.String>
}>

// One schema per status, told apart by the literal status, so the API encodes a problem with the status it carries
const problemSchema = <Status extends ProblemStatus>(status: Status): ProblemSchema<Status> =>
  Schema.Struct({
    type: Schema.String,
    title: Schema.String,
    status: Schema.Literal(status),
    detail: Schema.String,
    code: Schema.String,
    instance: Schema.optionalKey(Schema.String),
  })
    .annotate({ title: `Problem${status}`, description: 'RFC 9457 problem details' })
    .pipe(
      HttpApiSchema.status(status),
      HttpApiSchema.asJson({ contentType: 'application/problem+json' }),
    )

export const Problem400 = problemSchema(400)
export const Problem401 = problemSchema(401)
export const Problem403 = problemSchema(403)
export const Problem404 = problemSchema(404)
export const Problem409 = problemSchema(409)
export const Problem413 = problemSchema(413)
export const Problem422 = problemSchema(422)
export const Problem429 = problemSchema(429)
export const Problem500 = problemSchema(500)
export const Problem502 = problemSchema(502)
export const Problem503 = problemSchema(503)

// Every status a kernel failure can turn into; the endpoints that call the kernel declare them all
export const PROBLEM_SCHEMAS = [
  Problem403,
  Problem404,
  Problem409,
  Problem422,
  Problem500,
  Problem502,
  Problem503,
] as const

export const problem = <Status extends ProblemStatus>(
  status: Status,
  code: string,
  detail: string,
): ApiProblem<Status> => ({ type: problemType(code), title: TITLES[status], status, detail, code })

const SESSION_STATUS: Readonly<Record<SessionError['code'], ProblemStatus>> = {
  not_found: 404,
  invalid_transition: 409,
  provider_missing: 422,
  yolo_refused: 403,
  employee_missing: 422,
}
const ASK_STATUS: Readonly<Record<AskError['code'], ProblemStatus>> = {
  not_found: 404,
  not_pending: 409,
  invalid_answer: 422,
}
const PROVIDER_STATUS: Readonly<Record<ProviderError['kind'], ProblemStatus>> = {
  auth: 502,
  ratelimit: 502,
  crash: 502,
  protocol: 502,
  missing: 422,
}
const CONFLICTS: ReadonlySet<string> = new Set(['locked', 'dirty', 'has_sessions'])
const workspaceStatus = (code: string): ProblemStatus => (CONFLICTS.has(code) ? 409 : 422)

const toProblemOfRest = (error: unknown): ApiProblem => {
  if (error instanceof ConfigError) {
    return problem(422, 'config_invalid', `${error.file}${error.pointer}: ${error.reason}`)
  }
  if (error instanceof PluginError) {
    return problem(500, 'plugin_failed', `${error.plugin}: ${error.reason}`)
  }
  if (error instanceof StoreError) {
    return problem(503, 'store_unavailable', 'the store is unavailable')
  }
  return problem(500, 'internal', 'unexpected failure')
}

// The problem a kernel failure is told as; an unknown failure is not described, only logged by the caller
export const toProblem = (error: unknown): ApiProblem => {
  if (error instanceof SessionError) {
    return problem(SESSION_STATUS[error.code], `session_${error.code}`, error.reason)
  }
  if (error instanceof AskError) {
    return problem(ASK_STATUS[error.code], `ask_${error.code}`, error.reason)
  }
  if (error instanceof ProviderError) {
    return problem(PROVIDER_STATUS[error.kind], `provider_${error.kind}`, error.reason)
  }
  if (error instanceof WorkspaceError) {
    return problem(workspaceStatus(error.code), `workspace_${error.code}`, error.reason)
  }
  return toProblemOfRest(error)
}

// A kernel call inside a handler: its typed failure becomes a problem, and what is unexpected is logged before it does
export const orProblem = <Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, ApiProblem, Requirements> =>
  effect.pipe(
    Effect.tapError((failure) =>
      toProblem(failure).code === 'internal'
        ? Effect.logError('unexpected failure in an API handler', failure)
        : Effect.void,
    ),
    Effect.mapError(toProblem),
  )
