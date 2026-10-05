import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { BunSecretStore, bunSecrets } from './bun-secret-store.js'
import { TIMED_OUT, withinTime } from './within-time.js'

// A keychain that is locked or waits on a prompt would hold the start of the daemon; this is all it is given
const PROBE_TIMEOUT_MS = 3000

// A home as the file system has it, so a link to a home probes under the name of the home it leads to
const realHomeOf = (home: string): string => {
  try {
    return realpathSync(home)
  } catch {
    return path.resolve(home)
  }
}

// One name for every start of a home, and another for every other home: a daemon killed between the write and the delete leaves one entry, which the next start of its home overwrites and deletes, and two daemons on different homes never touch the same one
export const probeNameOf = (home: string): string =>
  `probe-${createHash('sha256').update(realHomeOf(home)).digest('hex').slice(0, 12)}`

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

async function forget(store: BunSecretStore, probe: string): Promise<void> {
  try {
    await store.delete(probe)
  } catch {
    // Best effort: the probe stays behind only where the keychain refuses its delete as well
  }
}

// The probe goes in and comes out again: nothing when it did, else why not
// It is deleted whatever came of it, a write the keychain lets in after the time included
async function roundTrip(store: BunSecretStore, probe: string): Promise<string | undefined> {
  try {
    await store.set(probe, 'probe')
    const value = await store.get(probe)
    return value === 'probe' ? undefined : 'the keychain did not give the probe back'
  } catch (error) {
    return `the keychain refused the probe: ${messageOf(error)}`
  } finally {
    await forget(store, probe)
  }
}

// The keychain where it answers the probe of the home in time, else why it is not available
export async function probeKeychain(home: string): Promise<BunSecretStore | string> {
  const secrets = bunSecrets()
  if (secrets === undefined) {
    return 'Bun.secrets is not available to this process'
  }
  const store = new BunSecretStore(secrets)
  const reason = await withinTime(roundTrip(store, probeNameOf(home)), PROBE_TIMEOUT_MS)
  if (reason === TIMED_OUT) {
    return `the keychain did not answer within ${PROBE_TIMEOUT_MS / 1000} s`
  }
  return reason ?? store
}
