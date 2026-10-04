import { Problem } from '@bytebureau/protocol'
import { Effect, Layer, Option } from 'effect'
import { HttpServerRequest } from 'effect/http'
import { RpcMiddleware } from 'effect/rpc'
import { clientKey, drawToken, MutationBuckets } from '../mutation-buckets.js'

export class RpcMutationLimit extends RpcMiddleware.Service<RpcMutationLimit>()(
  'bb/api/RpcMutationLimit',
  { error: Problem },
) {}

// The one procedure that changes nothing: it reads the event log
const SUBSCRIPTION = 'events.subscribe'

// A request on the socket runs in the context of its upgrade, which carries the address captured before the upgrade (Bun forgets it after)
// So the client is known by the address the REST limit knows it by, and both doors draw from one budget; without it the socket clients share one key
const socketKey: Effect.Effect<string> = Effect.serviceOption(
  HttpServerRequest.HttpServerRequest,
).pipe(Effect.map((upgrade) => Option.match(upgrade, { onNone: () => 'rpc', onSome: clientKey })))

export const RpcMutationLimitLive: Layer.Layer<RpcMutationLimit, never, MutationBuckets> =
  Layer.effect(
    RpcMutationLimit,
    Effect.gen(function* makeRpcMutationLimit() {
      const buckets = yield* MutationBuckets
      return (effect, { rpc }) => {
        const { _tag: tag } = rpc
        if (tag === SUBSCRIPTION) {
          return effect
        }
        return socketKey.pipe(
          Effect.flatMap((key) => drawToken(buckets, key)),
          Effect.andThen(effect),
        )
      }
    }),
  )
