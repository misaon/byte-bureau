import { SecretsBackend } from '@bytebureau/protocol'
import { Effect, Schema } from 'effect'
import { readLayer, type LoadedFile } from '../config/files.js'
import { isPlain } from '../config/merge.js'
import { ConfigError } from '../errors.js'
import { secretStoreFor } from '../secrets/secret-store-for.js'
import type { SecretsShape } from '../secrets/secrets.js'
import type { KernelOptions } from './types.js'

const isBackend = Schema.is(SecretsBackend)

// The backend the secrets section names, auto where it names none; anything else refuses the start, which auto would hide
const backendIn = ({ file, config }: LoadedFile): SecretsBackend => {
  const section = config['secrets']
  if (section === undefined) {
    return 'auto'
  }
  if (!isPlain(section)) {
    throw new ConfigError({ file, pointer: '/secrets', reason: 'expected an object' })
  }
  const { backend } = section
  if (backend === undefined || isBackend(backend)) {
    return backend ?? 'auto'
  }
  const reason = `expected "auto", "keychain" or "file", not ${JSON.stringify(backend)}`
  throw new ConfigError({ file, pointer: '/secrets/backend', reason })
}

type UserFile = { readonly loaded: LoadedFile | null } | { readonly failure: ConfigError }

const userFile = async (home: string): Promise<UserFile> => {
  const read = readLayer(home, 'config').pipe(
    Effect.match({
      onFailure: (failure): UserFile => ({ failure }),
      onSuccess: (loaded): UserFile => ({ loaded }),
    }),
  )
  const file = await Effect.runPromise(read)
  return file
}

// The secrets section of the user file on its own, so that a mistake in another section does not move the secrets elsewhere
// A file that cannot be read or parsed refuses the start as an unknown backend does: auto would probe the keychain and record it, where the file may say file
async function configuredBackend(home: string): Promise<SecretsBackend> {
  const read = await userFile(home)
  if ('failure' in read) {
    throw read.failure
  }
  return read.loaded === null ? 'auto' : backendIn(read.loaded)
}

// The store the options give, else the one the user configuration names
export async function bootSecrets(options: KernelOptions): Promise<SecretsShape> {
  if (options.secrets !== undefined) {
    return options.secrets
  }
  return secretStoreFor(options.home, await configuredBackend(options.home))
}
