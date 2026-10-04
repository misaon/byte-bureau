import {
  AskError,
  ConfigError,
  PluginError,
  ProviderError,
  redactValue,
  SessionError,
  StoreError,
  WorkspaceError,
} from '@bytebureau/kernel'
import { problemType, type Problem } from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import { HttpApiSchema } from 'effect/http-api'
import { logApiError, logApiWarning } from './logging.js'

export const PROBLEM_STATUSES = [400, 401, 403, 404, 409, 413, 422, 429, 500, 502, 503] as const
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number]

// Every status a kernel failure can turn into; the endpoints that call the kernel declare them all
export const KERNEL_STATUSES = [403, 404, 409, 422, 500, 502, 503] as const
export type KernelStatus = (typeof KERNEL_STATUSES)[number]

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
// The identifier names it under components.schemas of the OpenAPI document
const problemSchema = <Status extends ProblemStatus>(status: Status): ProblemSchema<Status> =>
  Schema.Struct({
    type: Schema.String,
    title: Schema.String,
    status: Schema.Literal(status),
    detail: Schema.String,
    code: Schema.String,
    instance: Schema.optionalKey(Schema.String),
  })
    .annotate({
      identifier: `Problem${status}`,
      title: `Problem${status}`,
      description: 'RFC 9457 problem details',
    })
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

// The schema of each status; the endpoints and the middlewares that declare a status share its one instance
const SCHEMAS: { readonly [Status in ProblemStatus]: ProblemSchema<Status> } = {
  400: Problem400,
  401: Problem401,
  403: Problem403,
  404: Problem404,
  409: Problem409,
  413: Problem413,
  422: Problem422,
  429: Problem429,
  500: Problem500,
  502: Problem502,
  503: Problem503,
}

// The error schemas of an endpoint that calls the kernel: one per status of KERNEL_STATUSES
export const PROBLEM_SCHEMAS: readonly (typeof SCHEMAS)[KernelStatus][] = KERNEL_STATUSES.map(
  (status) => SCHEMAS[status],
)

// The detail is told with every secret-shaped run of text replaced: it carries reasons from git, plugins and providers
export const problem = <Status extends ProblemStatus>(
  status: Status,
  code: string,
  detail: string,
): ApiProblem<Status> => ({
  type: problemType(code),
  title: TITLES[status],
  status,
  detail: String(redactValue(detail)),
  code,
})

export const UNEXPECTED_FAILURE = problem(500, 'internal', 'unexpected failure')

const SESSION_STATUS: Readonly<Record<SessionError['code'], KernelStatus>> = {
  not_found: 404,
  invalid_transition: 409,
  provider_missing: 422,
  yolo_refused: 403,
  employee_missing: 422,
}
const ASK_STATUS: Readonly<Record<AskError['code'], KernelStatus>> = {
  not_found: 404,
  not_pending: 409,
  invalid_answer: 422,
}
const PROVIDER_STATUS: Readonly<Record<ProviderError['kind'], KernelStatus>> = {
  auth: 502,
  ratelimit: 502,
  crash: 502,
  protocol: 502,
  missing: 422,
}
const CONFLICTS: ReadonlySet<string> = new Set(['locked', 'dirty', 'has_sessions'])
const workspaceStatus = (code: string): KernelStatus => (CONFLICTS.has(code) ? 409 : 422)

const toProblemOfRest = (error: unknown): ApiProblem<KernelStatus> => {
  if (error instanceof ConfigError) {
    return problem(422, 'config_invalid', `${error.file}${error.pointer}: ${error.reason}`)
  }
  if (error instanceof PluginError) {
    return problem(500, 'plugin_failed', `${error.plugin}: ${error.reason}`)
  }
  if (error instanceof StoreError) {
    return problem(503, 'store_unavailable', 'the store is unavailable')
  }
  return UNEXPECTED_FAILURE
}

// The problem a kernel failure is told as; an unknown failure is not described, only logged by the caller
export const toProblem = (error: unknown): ApiProblem<KernelStatus> => {
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

// What the client is not told is logged: the cause behind an unavailable store, and a failure the API did not expect
const logUntold = (failure: unknown): Effect.Effect<void> => {
  if (failure instanceof StoreError) {
    return logApiWarning('the store failed under an API call', failure.cause)
  }
  return toProblem(failure).code === 'internal'
    ? logApiError('unexpected failure in an API handler', failure)
    : Effect.void
}

// A kernel call inside a handler: its failure becomes a problem with a status the endpoint declares
export const orProblem = <Value, Failure, Requirements>(
  effect: Effect.Effect<Value, Failure, Requirements>,
): Effect.Effect<Value, ApiProblem<KernelStatus>, Requirements> =>
  effect.pipe(Effect.tapError(logUntold), Effect.mapError(toProblem))
