import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Effect } from 'effect'
import { toStoreError, type StoreError } from '../errors.js'

// A provider id may hold a colon (acp:codex), which not every file system takes in a name
export const profileDirOf = (home: string, providerId: string, name: string): string =>
  path.join(home, 'profiles', providerId.replaceAll(':', '-'), name)

// The directory holds a login, so the one this call creates is the user's alone whatever the umask
// One that exists, such as the login of a profile added again, keeps its mode
export const ensureProfileDir = (dir: string): Effect.Effect<void, StoreError> =>
  Effect.try({
    try: () => {
      if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) {
        chmodSync(dir, 0o700)
      }
    },
    catch: toStoreError,
  })

export const removeProfileDir = (dir: string): Effect.Effect<void, StoreError> =>
  Effect.try({
    try: () => {
      rmSync(dir, { recursive: true, force: true })
    },
    catch: toStoreError,
  })
