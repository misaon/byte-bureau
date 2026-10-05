import type { SecretsShape } from './secrets.js'

// Secrets for as long as the process lives: the store of a kernel that is given none, as the test kernels are
export class InMemorySecretStore implements SecretsShape {
  public readonly backend = 'memory' as const
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
