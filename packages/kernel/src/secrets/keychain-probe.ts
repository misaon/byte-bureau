import { BunSecretStore, bunSecrets } from './bun-secret-store.js'
import { TIMED_OUT, withinTime } from './within-time.js'

// A keychain that is locked or waits on a prompt would hold the start of the daemon; this is all it is given
const PROBE_TIMEOUT_MS = 3000

// One name for every start: a daemon killed between the write and the delete leaves one entry, which the next start overwrites and deletes
const PROBE = 'probe'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

async function forget(store: BunSecretStore): Promise<void> {
  try {
    await store.delete(PROBE)
  } catch {
    // Best effort: the probe stays behind only where the keychain refuses its delete as well
  }
}

// The probe goes in and comes out again: nothing when it did, else why not
// It is deleted whatever came of it, a write the keychain lets in after the time included
async function roundTrip(store: BunSecretStore): Promise<string | undefined> {
  try {
    await store.set(PROBE, 'probe')
    const value = await store.get(PROBE)
    return value === 'probe' ? undefined : 'the keychain did not give the probe back'
  } catch (error) {
    return `the keychain refused the probe: ${messageOf(error)}`
  } finally {
    await forget(store)
  }
}

// The keychain where it answers the probe in time, else why it is not available
export async function probeKeychain(): Promise<BunSecretStore | string> {
  const secrets = bunSecrets()
  if (secrets === undefined) {
    return 'Bun.secrets is not available to this process'
  }
  const store = new BunSecretStore(secrets)
  const reason = await withinTime(roundTrip(store), PROBE_TIMEOUT_MS)
  if (reason === TIMED_OUT) {
    return `the keychain did not answer within ${PROBE_TIMEOUT_MS / 1000} s`
  }
  return reason ?? store
}
