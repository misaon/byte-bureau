import { Effect } from 'effect'
import { toStoreError, type StoreError } from '../errors.js'
import type { SecretsShape } from '../secrets/secrets.js'

// The kernel's keys start with @bytebureau/, which no plugin name can: a plugin's are <plugin>/<key>, its name a kebab-case word
const keyOf = (profileId: string): string => `@bytebureau/profiles/${profileId}/api_key`

// A secret store that fails has failed like the store, not like the kernel
export const readKey = (
  secrets: SecretsShape,
  profileId: string,
): Effect.Effect<string | undefined, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      const value = await secrets.get(keyOf(profileId))
      return value
    },
    catch: toStoreError,
  })

export const writeKey = (
  secrets: SecretsShape,
  profileId: string,
  value: string,
): Effect.Effect<void, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      await secrets.set(keyOf(profileId), value)
    },
    catch: toStoreError,
  })

export const dropKey = (
  secrets: SecretsShape,
  profileId: string,
): Effect.Effect<void, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      await secrets.delete(keyOf(profileId))
    },
    catch: toStoreError,
  })
