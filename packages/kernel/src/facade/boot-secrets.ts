import { SecretsBackend } from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import { readLayer, type LoadedFile } from '../config/files.js'
import { isPlain } from '../config/merge.js'
import { secretStoreFor } from '../secrets/secret-store-for.js'
import type { SecretsShape } from '../secrets/secrets.js'
import type { KernelOptions } from './types.js'

const isBackend = Schema.is(SecretsBackend)

const backendIn = (loaded: LoadedFile | null): SecretsBackend => {
  const section = loaded === null ? undefined : loaded.config['secrets']
  const backend = isPlain(section) ? section['backend'] : undefined
  return isBackend(backend) ? backend : 'auto'
}

// The secrets section of the user file on its own, so that a mistake in another section does not move the secrets elsewhere
// A file that cannot be parsed, or a section that names no backend, leaves the choice to auto
async function configuredBackend(home: string): Promise<SecretsBackend> {
  const read = readLayer(home, 'config').pipe(
    Effect.match({ onFailure: (): SecretsBackend => 'auto', onSuccess: backendIn }),
  )
  const backend = await Effect.runPromise(read)
  return backend
}

// The store the options give, else the one the user configuration names
export async function bootSecrets(options: KernelOptions): Promise<SecretsShape> {
  if (options.secrets !== undefined) {
    return options.secrets
  }
  return secretStoreFor(options.home, await configuredBackend(options.home))
}
