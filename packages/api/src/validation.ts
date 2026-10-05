import { Effect, SchemaIssue, type Layer, type Schema } from 'effect'
import { HttpApiMiddleware } from 'effect/http-api'
import { logApiError } from './logging.js'
import { Problem400, Problem500, problem, UNEXPECTED_FAILURE } from './problems.js'

// A body, query, path or header the schema refuses is a 400 problem that names the part and the reason
export class RequestValidation extends HttpApiMiddleware.Service<RequestValidation>()(
  'bb/api/RequestValidation',
  { error: [Problem400, Problem500] },
) {}

// A response its own schema refuses is a fault of the server: logged, and told as an unexpected failure
const RESPONSE_PARTS: ReadonlySet<string> = new Set(['Body', 'ResponseHeaders'])

const FIXED = [
  [SchemaIssue.MissingKey, 'Missing key'],
  [SchemaIssue.UnexpectedKey, 'Expected no excess property'],
  [SchemaIssue.Forbidden, 'Forbidden operation'],
  [SchemaIssue.OneOf, 'Expected exactly one member to match'],
] as const

const fixedOf = (issue: SchemaIssue.Leaf): string => {
  const found = FIXED.find(([type]) => issue instanceof type)
  return found === undefined ? 'Expected a valid value' : found[1]
}

// What was expected, never what was given: an input, or a message made from one, could hold a key the request carried
const leafHook: SchemaIssue.LeafHook = (issue) =>
  issue instanceof SchemaIssue.InvalidType
    ? SchemaIssue.defaultLeafHook(new SchemaIssue.InvalidType(issue.ast))
    : fixedOf(issue)

const checkHook: SchemaIssue.CheckHook = ({ filter }) => {
  const expected = filter.annotations === undefined ? undefined : filter.annotations.expected
  return `Expected ${typeof expected === 'string' ? expected : 'a valid value'}`
}

const formatter = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook, checkHook })

const keyOf = (segment: PropertyKey | { readonly key: PropertyKey }): string => {
  const key = typeof segment === 'object' ? segment.key : segment
  return typeof key === 'symbol' ? `[${String(key)}]` : `[${JSON.stringify(key)}]`
}

// The part, then each place and the shape it expected, as Effect words them: `Query: Expected a finite number\n  at ["since"]`
const detailOf = (kind: string, cause: Schema.SchemaError): string => {
  const lines = formatter(cause.issue).issues.map(({ message, path }) =>
    path === undefined || path.length === 0
      ? message
      : `${message}\n  at ${path.map((segment) => keyOf(segment)).join('')}`,
  )
  return `${kind}: ${lines.join('\n')}`
}

export const RequestValidationLive: Layer.Layer<RequestValidation> =
  HttpApiMiddleware.layerSchemaErrorTransform(RequestValidation, (refused) =>
    RESPONSE_PARTS.has(refused.kind)
      ? logApiError('a response its schema refuses', refused.cause).pipe(
          Effect.andThen(Effect.fail(UNEXPECTED_FAILURE)),
        )
      : Effect.fail(problem(400, 'request_invalid', detailOf(refused.kind, refused.cause))),
  )
