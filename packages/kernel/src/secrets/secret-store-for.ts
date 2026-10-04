import path from 'node:path'
import type { SecretsBackend } from '@bytebureau/protocol'
import { BunSecretStore, bunSecrets } from './bun-secret-store.js'
import { FileSecretStore } from './file-secret-store.js'
import type { SecretsShape } from './secrets.js'

const fileStore = (home: string): FileSecretStore =>
  new FileSecretStore(path.join(home, 'secrets.json'))

// A probe that goes in and comes out again; a keychain that refuses it is not available (locked, headless, no secret service)
const probed = async (store: BunSecretStore): Promise<boolean> => {
  const key = `probe/${process.pid}`
  try {
    await store.set(key, 'probe')
    const value = await store.get(key)
    await store.delete(key)
    return value === 'probe'
  } catch {
    return false
  }
}

const keychain = async (): Promise<BunSecretStore | undefined> => {
  const secrets = bunSecrets()
  if (secrets === undefined) {
    return undefined
  }
  const store = new BunSecretStore(secrets)
  return (await probed(store)) ? store : undefined
}

// The store the backend names: the file under the home, or the keychain, which auto takes where it works and keychain demands
export const secretStoreFor = async (
  home: string,
  backend: SecretsBackend,
): Promise<SecretsShape> => {
  if (backend === 'file') {
    return fileStore(home)
  }
  const store = await keychain()
  if (store !== undefined) {
    return store
  }
  if (backend === 'keychain') {
    throw new Error(
      'the keychain is not available to this daemon; set secrets.backend to file or auto',
    )
  }
  return fileStore(home)
}
