import path from 'node:path'
import { readIfPresent, writePrivate } from './private-file.js'
import type { SecretBackend } from './secrets.js'

// What auto chooses between
export type ChosenBackend = Exclude<SecretBackend, 'memory'>

const recordOf = (home: string): string => path.join(home, 'secrets.backend')

// The backend auto chose at an earlier start of the home; nothing before the first
// A record that names neither is refused: choosing again could put the secrets out of reach unnoticed
export function recordedBackend(home: string): ChosenBackend | undefined {
  const text = readIfPresent(recordOf(home))
  if (text === undefined) {
    return undefined
  }
  const recorded = text.trim()
  if (recorded === 'keychain' || recorded === 'file') {
    return recorded
  }
  throw new Error(
    `${recordOf(home)} names neither keychain nor file; remove it to let auto choose again`,
  )
}

// One word, for the user alone, as the token of the daemon is
export const recordBackend = (home: string, backend: ChosenBackend): void => {
  writePrivate(recordOf(home), `${backend}\n`)
}
