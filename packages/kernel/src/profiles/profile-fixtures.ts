import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Plugin } from '@bytebureau/plugin-api'
import { Effect, Layer } from 'effect'
import { ProfileError } from '../errors.js'
import { KernelTest } from '../kernel-test.js'
import { PluginHost } from '../plugins/plugin-host.js'
import type { SecretsShape } from '../secrets/secrets.js'
import { ProfileService, type ProfileServiceShape } from './profile-service.js'

// A kernel over an in-memory store and a home of its own, which is removed with the layer
export interface ProfileWorld {
  readonly home: string
  readonly layer: ReturnType<typeof KernelTest>
}

export const profileWorld = (
  plugins: readonly Plugin[] = [],
  secrets?: SecretsShape,
): ProfileWorld => {
  const created = mkdtempSync(path.join(tmpdir(), 'bb-home-'))
  const home = realpathSync(created)
  const removal = Layer.effectDiscard(
    Effect.addFinalizer(() =>
      Effect.sync(() => {
        rmSync(home, { recursive: true, force: true })
      }),
    ),
  )
  return {
    home,
    layer: KernelTest({ home, extraPlugins: plugins, secrets }).pipe(Layer.provideMerge(removal)),
  }
}

// The profile service once the plugins have loaded, so that their providers are known
export const loadedProfiles: Effect.Effect<
  ProfileServiceShape,
  never,
  PluginHost | ProfileService
> = Effect.gen(function* loadsProfiles() {
  yield* (yield* PluginHost).load()
  return yield* ProfileService
})

// What a refused attempt says: the code of a profile error, else the name of the error; one that succeeds fails the test
export const codeOf = <Value>(attempt: Effect.Effect<Value, Error>): Effect.Effect<string, Value> =>
  Effect.map(Effect.flip(attempt), (failure) =>
    failure instanceof ProfileError ? failure.code : failure.name,
  )
