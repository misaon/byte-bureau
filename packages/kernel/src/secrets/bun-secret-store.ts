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
    const value = await this.secrets.get({ service: this.service, name: key })
    return value ?? undefined
  }

  public async set(key: string, value: string): Promise<void> {
    await this.secrets.set({ service: this.service, name: key, value })
  }

  public async delete(key: string): Promise<void> {
    await this.secrets.delete({ service: this.service, name: key })
  }
}
