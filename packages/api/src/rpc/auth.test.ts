import { Cause, Effect, Exit, Layer, Redacted } from 'effect'
import { Headers } from 'effect/http'
import { describe, expect, it } from 'vitest'
import { bearerOf, RpcAuthorizationLive } from './auth.js'

// The authorization header of a request envelope and the token read from it
const READ: [string, string | undefined][] = [
  ['Bearer abc', 'abc'],
  ['bearer abc', 'abc'],
  ['BEARER  abc ', 'abc'],
  ['Bearer ', ''],
  ['Basic abc', undefined],
  ['Bearer-abc', undefined],
]

// What building the layer dies with, or nothing when it builds
const buildFailure = <Out>(layer: Layer.Layer<Out>): string => {
  const built = Effect.runSyncExit(Effect.scoped(Layer.build(layer)))
  return Exit.match(built, { onFailure: (cause) => Cause.pretty(cause), onSuccess: () => '' })
}

describe(bearerOf, () => {
  it.each(READ)('reads %j as %j', (header, token) => {
    const headers = Headers.fromInput([['authorization', header]])
    expect(bearerOf(headers)).toBe(token)
  })

  it('reads no token from a request without the header', () => {
    expect(bearerOf(Headers.empty)).toBeUndefined()
  })
})

describe(RpcAuthorizationLive, () => {
  it('refuses to build without a token, which would let every request in', () => {
    const withoutToken = RpcAuthorizationLive(Redacted.make(''))
    expect(buildFailure(withoutToken)).toContain('the API token must not be empty')
    const withToken = RpcAuthorizationLive(Redacted.make('token'))
    expect(buildFailure(withToken)).toBe('')
  })
})
