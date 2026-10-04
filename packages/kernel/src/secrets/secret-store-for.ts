import path from 'node:path'
import type { SecretsBackend } from '@bytebureau/protocol'
import { kernelLogger } from '../logging/logging.js'
import { recordBackend, recordedBackend, type ChosenBackend } from './backend-record.js'
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

// Auto at the first start of a home takes the keychain where it answers the probe, else the file, and keeps to it from then on
async function chosen(home: string): Promise<Choice> {
  const probed = await probeKeychain()
  if (typeof probed !== 'string') {
    recordBackend(home, 'keychain')
    return { store: probed, reason: 'auto: the keychain answered' }
  }
  recordBackend(home, 'file')
  logger.warn(`${probed}: the secrets are kept in ${fileOf(home)} from now on`)
  return fileChoice(home, `auto: ${probed}`)
}

// Auto after that keeps what it chose: the file even where the keychain answers now, the keychain while it answers
async function kept(home: string, recorded: ChosenBackend): Promise<Choice> {
  if (recorded === 'file') {
    return fileChoice(home, 'auto, as recorded in secrets.backend')
  }
  const probed = await probeKeychain()
  if (typeof probed !== 'string') {
    return { store: probed, reason: 'auto, as recorded in secrets.backend' }
  }
  logger.warn(
    `the secrets kept in the keychain are not available (${probed}); new ones go to ${fileOf(home)} until it answers`,
  )
  return fileChoice(home, 'auto: the keychain it chose before is not available')
}

// File and keychain go by the configuration alone; auto goes by the record of what it chose, once there is one
const choiceFor = async (home: string, backend: SecretsBackend): Promise<Choice> => {
  if (backend === 'file') {
    return fileChoice(home, 'secrets.backend is file')
  }
  if (backend === 'keychain') {
    const demand = await demanded()
    return demand
  }
  const recorded = recordedBackend(home)
  const choice = recorded === undefined ? await chosen(home) : await kept(home, recorded)
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
