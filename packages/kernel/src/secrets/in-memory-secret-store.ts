import type { SecretStore } from '@bytebureau/plugin-api'

// Phase A placeholder; Phase C replaces it with the keychain and the age-encrypted fallback
export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  public async get(key: string): Promise<string | undefined> {
    await Promise.resolve()
    return this.values.get(key)
  }

  public async set(key: string, value: string): Promise<void> {
    await Promise.resolve()
    this.values.set(key, value)
  }

  public async delete(key: string): Promise<void> {
    await Promise.resolve()
    this.values.delete(key)
  }
}
