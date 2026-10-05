import { TIMED_OUT, withinTime } from './within-time.js'
import type { SecretsShape } from './secrets.js'

interface Entry {
  readonly service: string
  readonly name: string
}

interface BunSecrets {
  readonly get: (entry: Entry) => Promise<string | null>
  readonly set: (entry: Entry & { readonly value: string }) => Promise<void>
  readonly delete: (entry: Entry) => Promise<boolean>
}

const METHODS = ['get', 'set', 'delete'] as const

// A keychain item another binary stored makes macOS ask before it is read, and a daemon nobody watches would wait on that dialog for ever
const KEYCHAIN_TIMEOUT_MS = 10_000

const isBunSecrets = (value: unknown): value is BunSecrets =>
  typeof value === 'object' &&
  value !== null &&
  METHODS.every((method) => typeof Reflect.get(value, method) === 'function')

// Bun.secrets as the runtime offers it; nothing under Node, which the tests run on
export const bunSecrets = (): BunSecrets | undefined => {
  const runtime: unknown = Reflect.get(globalThis, 'Bun')
  if (typeof runtime !== 'object' || runtime === null) {
    return undefined
  }
  const secrets: unknown = Reflect.get(runtime, 'secrets')
  return isBunSecrets(secrets) ? secrets : undefined
}

// What the keychain answered, else an error that names the keychain and the way out
async function answered<Value>(call: Promise<Value>): Promise<Value> {
  const outcome = await withinTime(call, KEYCHAIN_TIMEOUT_MS)
  if (outcome === TIMED_OUT) {
    throw new Error(
      `the keychain did not answer within ${KEYCHAIN_TIMEOUT_MS / 1000} s — a Keychain dialog may be waiting for approval, or set secrets.backend to file`,
    )
  }
  return outcome
}

// The keychain of the system through Bun.secrets: Keychain Services on macOS, the Secret Service on Linux, the Credential Manager on Windows
export class BunSecretStore implements SecretsShape {
  public readonly backend = 'keychain' as const
  private readonly secrets: BunSecrets
  private readonly service: string

  public constructor(secrets: BunSecrets, service = 'bytebureau') {
    this.secrets = secrets
    this.service = service
  }

  public async get(key: string): Promise<string | undefined> {
    const value = await answered(this.secrets.get({ service: this.service, name: key }))
    return value ?? undefined
  }

  public async set(key: string, value: string): Promise<void> {
    await answered(this.secrets.set({ service: this.service, name: key, value }))
  }

  public async delete(key: string): Promise<void> {
    await answered(this.secrets.delete({ service: this.service, name: key }))
  }
}
