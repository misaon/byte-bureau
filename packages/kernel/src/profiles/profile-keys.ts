import { Effect } from 'effect'
import { toStoreError, type StoreError } from '../errors.js'
import type { SecretsShape } from '../secrets/secrets.js'

// The kernel's keys start with @bytebureau/, which no plugin name can: a plugin's are <plugin>/<key>, its name a kebab-case word
export const secretKeyOf = (profileId: string): string =>
  `@bytebureau/profiles/${profileId}/api_key`

// What to say of an api_key profile whose key has left the secret store
export const lostKeyReason = (profileId: string): string =>
  `the key of profile "${profileId}" is not in the secret store; remove the profile and add it again`

// A secret store that fails has failed like the store, not like the kernel
const readKey = (
  secrets: SecretsShape,
  profileId: string,
): Effect.Effect<string | undefined, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      const value = await secrets.get(secretKeyOf(profileId))
      return value
    },
    catch: toStoreError,
  })

// The key of a profile as the secret store holds it; one that is gone, or empty, is none
export const usableKeyOf = (
  secrets: SecretsShape,
  profileId: string,
): Effect.Effect<string | undefined, StoreError> =>
  Effect.map(readKey(secrets, profileId), (value) => (value === '' ? undefined : value))

export const writeKey = (
  secrets: SecretsShape,
  profileId: string,
  value: string,
): Effect.Effect<void, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      await secrets.set(secretKeyOf(profileId), value)
    },
    catch: toStoreError,
  })

export const dropKey = (
  secrets: SecretsShape,
  profileId: string,
): Effect.Effect<void, StoreError> =>
  Effect.tryPromise({
    try: async () => {
      await secrets.delete(secretKeyOf(profileId))
    },
    catch: toStoreError,
  })
