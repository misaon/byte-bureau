import {
  definePlugin,
  type AgentProvider,
  type AuthStatus,
  type Plugin,
} from '@bytebureau/plugin-api'
import { manifestOf, providerOf } from '../plugins/plugin-fixtures.js'
import { InMemorySecretStore } from '../secrets/in-memory-secret-store.js'
import type { SecretsShape } from '../secrets/secrets.js'

const failingStatus = async (): Promise<AuthStatus> => {
  await Promise.resolve()
  throw new Error('the account check failed')
}

// A provider whose account check throws, and which takes no API-key profile
export const doubtingPlugin: Plugin = definePlugin({
  manifest: manifestOf('doubting', { contributes: { agentProviders: ['doubting'] } }),
  setup: () => {
    const provider: AgentProvider = { ...providerOf('doubting'), authStatus: failingStatus }
    return { agentProviders: [provider] }
  },
})

const lockedStore = new InMemorySecretStore()

// A secret store that refuses to keep a secret, as a locked keychain would
export const refusingSecrets: SecretsShape = {
  backend: 'keychain',
  get: async (key) => {
    const value = await lockedStore.get(key)
    return value
  },
  set: async () => {
    await Promise.resolve()
    throw new Error('the keychain is locked')
  },
  delete: async (key) => {
    await lockedStore.delete(key)
  },
}

const stickyStore = new InMemorySecretStore()

// A secret store that keeps what it is given and refuses to let it go, as a file it cannot rewrite would
export const stickySecrets: SecretsShape = {
  backend: 'file',
  get: async (key) => {
    const value = await stickyStore.get(key)
    return value
  },
  set: async (key, value) => {
    await stickyStore.set(key, value)
  },
  delete: async () => {
    await Promise.resolve()
    throw new Error('the secrets file cannot be written')
  },
}
