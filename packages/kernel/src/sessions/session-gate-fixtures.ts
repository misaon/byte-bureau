import { Effect, Latch, Layer } from 'effect'
import { StoreError } from '../errors.js'
import { UsageService, UsageServiceLive } from '../usage/usage-service.js'

// A usage service whose recording of a rate limit waits until the test lets it through
// The gate shows when a recording has begun, and keeps the event that causes it from being applied until it is released
export interface Gate {
  readonly layer: typeof UsageServiceLive
  readonly entered: Latch.Latch
  readonly release: Latch.Latch
}

export const gatedUsage = (): Gate => {
  const entered = Latch.makeUnsafe()
  const release = Latch.makeUnsafe()
  const layer = Layer.effect(
    UsageService,
    Effect.gen(function* gatesUsage() {
      const usage = yield* UsageService
      return UsageService.of({
        ...usage,
        record: (profileId, rateLimit) =>
          Effect.andThen(
            Effect.andThen(entered.open, release.await),
            usage.record(profileId, rateLimit),
          ),
      })
    }),
  ).pipe(Layer.provide(UsageServiceLive))
  return { layer, entered, release }
}

// A usage service that cannot record anything
export const failingUsage = (): typeof UsageServiceLive =>
  Layer.effect(
    UsageService,
    Effect.gen(function* failsUsage() {
      const usage = yield* UsageService
      return UsageService.of({
        ...usage,
        record: () => Effect.fail(new StoreError({ cause: 'the disk is full' })),
      })
    }),
  ).pipe(Layer.provide(UsageServiceLive))
