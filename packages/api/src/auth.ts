import { timingSafeEqual } from 'node:crypto'
import { Effect, Layer, Redacted } from 'effect'
import { HttpApiMiddleware, HttpApiSecurity } from 'effect/http-api'
import { Problem401, problem } from './problems.js'

export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  'bb/api/Authorization',
  { security: { bearer: HttpApiSecurity.bearer }, error: Problem401 },
) {}

// Worded so the redaction of details leaves it alone: it hides any "Bearer <word>"
const UNAUTHORIZED = problem(401, 'unauthorized', 'a valid API token is required')

// An empty token matches nothing, since a request without the header arrives with an empty one
// Otherwise lengths first, then a constant-time comparison: the daemon never tells how much of a token was right
export const sameToken = (given: string, expected: string): boolean => {
  const left = Buffer.from(given, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return right.length > 0 && left.length === right.length && timingSafeEqual(left, right)
}

// A daemon without a token would let every request in, so the layer refuses to build; the caller made a mistake
export const AuthorizationLive = (token: Redacted.Redacted): Layer.Layer<Authorization> => {
  if (Redacted.value(token).length === 0) {
    return Layer.effect(Authorization, Effect.die(new Error('the API token must not be empty')))
  }
  return Layer.succeed(Authorization, {
    bearer: (httpEffect, { credential }) =>
      sameToken(Redacted.value(credential), Redacted.value(token))
        ? httpEffect
        : Effect.fail(UNAUTHORIZED),
  })
}
