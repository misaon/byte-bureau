import type { SecretStore } from '@bytebureau/plugin-api'
import { Context } from 'effect'

export type SecretBackend = 'keychain' | 'file' | 'memory'

// A secret store that tells where it keeps its secrets
export interface SecretsShape extends SecretStore {
  readonly backend: SecretBackend
}

export class Secrets extends Context.Service<Secrets, SecretsShape>()('bb/Secrets') {}
