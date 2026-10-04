import path from 'node:path'
import type { SecretsBackend } from '@bytebureau/protocol'
import { kernelLogger } from '../logging/logging.js'
import { FileSecretStore } from './file-secret-store.js'
import { probeKeychain } from './keychain-probe.js'
import type { SecretsShape } from './secrets.js'

const logger = kernelLogger(['bb', 'secrets'])

interface Choice {
  readonly store: SecretsShape
  // Why it is this store, for the line the start logs
  readonly reason: string
}

const fileOf = (home: string): string => path.join(home, 'secrets.json')

const fileChoice = (home: string, reason: string): Choice => ({
  store: new FileSecretStore(fileOf(home)),
  reason,
})

// The keychain backend demands the keychain: one that is not available refuses the start, with the reason
async function demanded(): Promise<Choice> {
  const probed = await probeKeychain()
  if (typeof probed !== 'string') {
    return { store: probed, reason: 'secrets.backend is keychain' }
  }
  throw new Error(
    `the keychain is not available to this daemon (${probed}); set secrets.backend to file or auto`,
  )
}

// Auto takes the keychain where it answers the probe, else the file, and says why
async function chosen(home: string): Promise<Choice> {
  const probed = await probeKeychain()
  if (typeof probed !== 'string') {
    return { store: probed, reason: 'auto: the keychain answered' }
  }
  logger.warn(`${probed}: the secrets are kept in ${fileOf(home)}`)
  return fileChoice(home, `auto: ${probed}`)
}

const choiceFor = async (home: string, backend: SecretsBackend): Promise<Choice> => {
  if (backend === 'file') {
    return fileChoice(home, 'secrets.backend is file')
  }
  const choice = backend === 'keychain' ? await demanded() : await chosen(home)
  return choice
}

// The store the backend names: the file under the home, or the keychain, which auto takes where it answers and keychain demands
// The choice is logged once, at debug: a start that goes as configured says nothing on stderr, a fallback warns
export const secretStoreFor = async (
  home: string,
  backend: SecretsBackend,
): Promise<SecretsShape> => {
  const { store, reason } = await choiceFor(home, backend)
  logger.debug(`secrets backend: ${store.backend} (${reason})`)
  return store
}
