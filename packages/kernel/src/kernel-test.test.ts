import { assert, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { UsageLayer } from './kernel-foundation.js'
import { KernelTest } from './kernel-test.js'
import { failingUsage } from './sessions/session-gate-fixtures.js'
import { tempDir } from './testing/temp-repo.js'
import { UsageService } from './usage/usage-service.js'

// Whether the usage service of a kernel records a rate limit
const records = (usage?: UsageLayer): Effect.Effect<boolean> => {
  const kernel = KernelTest({ home: tempDir('bb-home-') }, usage)
  return Effect.gen(function* recordsRateLimit() {
    const service = yield* UsageService
    return yield* Effect.match(service.record('profile', {}), {
      onFailure: () => false,
      onSuccess: () => true,
    })
  }).pipe(Effect.provide(kernel))
}

it.effect('offers the live usage service unless a test swaps in its own', () =>
  Effect.gen(function* offersLiveUsage() {
    assert.isTrue(yield* records())
  }),
)

it.effect('offers the usage service a test swaps in', () =>
  Effect.gen(function* offersSwappedUsage() {
    assert.isFalse(yield* records(failingUsage()))
  }),
)
