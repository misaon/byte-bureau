import { timingSafeEqual } from 'node:crypto'
import { Effect, Layer, Redacted } from 'effect'
import { HttpApiMiddleware, HttpApiSecurity } from 'effect/http-api'
import { Problem401, problem } from './problems.js'

export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  'bb/api/Authorization',
  { security: { bearer: HttpApiSecurity.bearer }, error: Problem401 },
) {}

const UNAUTHORIZED = problem(401, 'unauthorized', 'a valid bearer token is required')

// Lengths first, then a constant-time comparison: the daemon never tells how much of a token was right
export const sameToken = (given: string, expected: string): boolean => {
  const left = Buffer.from(given, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

export const AuthorizationLive = (token: Redacted.Redacted): Layer.Layer<Authorization> =>
  Layer.succeed(Authorization, {
    bearer: (httpEffect, { credential }) =>
      sameToken(Redacted.value(credential), Redacted.value(token))
        ? httpEffect
        : Effect.fail(UNAUTHORIZED),
  })
