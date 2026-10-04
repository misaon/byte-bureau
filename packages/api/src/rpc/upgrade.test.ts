import { assert, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { HttpServerRequest, HttpServerResponse } from 'effect/http'
import { guardedUpgrade } from './upgrade.js'

const ADDRESS = '203.0.113.9'

interface Upgrading {
  readonly request: HttpServerRequest.HttpServerRequest
  readonly upgrade: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >
  // The address a request on the socket saw, if the upgrade ran
  readonly seen: () => string | undefined
}

// A request as Bun serves it, whose address is gone once it has been upgraded, and an upgrade that makes it so
// The upgrade records the address that a request on the socket then reads from its context
const bunUpgrade = (headers: Record<string, string> = {}): Upgrading => {
  const state: { upgraded: boolean; seen: string | undefined } = {
    upgraded: false,
    seen: undefined,
  }
  const served = HttpServerRequest.fromWeb(
    new Request('http://127.0.0.1:4747/api/v1/ws', { headers }),
  )
  const addressNow = (): Option.Option<string> =>
    state.upgraded ? Option.none() : Option.some(ADDRESS)
  const request = new Proxy(served, {
    get: (target, key, receiver): unknown =>
      key === 'remoteAddress' ? addressNow() : Reflect.get(target, key, receiver),
  })
  const upgrade = Effect.gen(function* upgrades() {
    state.upgraded = true
    const current = yield* HttpServerRequest.HttpServerRequest
    state.seen = Option.getOrUndefined(current.remoteAddress)
    return HttpServerResponse.empty()
  })
  return { request, upgrade, seen: () => state.seen }
}

it.effect(
  'keeps for the socket the address the request came from, which Bun forgets at the upgrade',
  () =>
    Effect.gen(function* keepsAddress() {
      const { request, upgrade, seen } = bunUpgrade()
      const guarded = guardedUpgrade(upgrade, [])
      yield* guarded.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
      assert.strictEqual(seen(), ADDRESS)
    }),
)

it.effect('models Bun: without the guard a request on the socket sees no address', () =>
  Effect.gen(function* losesAddress() {
    const { request, upgrade, seen } = bunUpgrade()
    yield* upgrade.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request))
    assert.isUndefined(seen())
  }),
)

it.effect('turns away a browser from a foreign origin with 403 and does not upgrade', () =>
  Effect.gen(function* refuses() {
    const { request, upgrade, seen } = bunUpgrade({ origin: 'http://evil.example' })
    const guarded = guardedUpgrade(upgrade, [])
    const response = yield* guarded.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
    )
    assert.strictEqual(response.status, 403)
    assert.isUndefined(seen())
  }),
)
