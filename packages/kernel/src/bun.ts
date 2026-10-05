import path from 'node:path'
import { Effect, Layer } from 'effect'
import type { SqlClient } from 'effect/sql'
import { bootLevel, configureKernelLogging } from './facade/boot-logging.js'
import { bootSecrets } from './facade/boot-secrets.js'
import { createKernelFrom, type Kernel, type KernelOptions, type Services } from './facade.js'
import { KernelLayer } from './kernel-live.js'
import { effectLevelOf, kernelLogger, type KernelLogLevel } from './logging/logging.js'
import { prepareHome, restrictDatabase } from './store/home.js'
import { StoreLive } from './store/store-live.js'

export { StoreLive } from './store/store-live.js'
export type { Kernel, KernelOptions } from './facade.js'

// What could not be made private is a warning: the start goes on
const warnAll = (warnings: readonly string[]): void => {
  const logger = kernelLogger(['bb', 'store'])
  for (const warning of warnings) {
    logger.warn(warning)
  }
}

// The database, its WAL and its shared memory exist once the store has opened and migrated it; they are narrowed to the user then
const privateStore = (database: string): Layer.Layer<SqlClient.SqlClient> =>
  StoreLive(database).pipe(
    Layer.tap(() =>
      Effect.sync(() => {
        warnAll(restrictDatabase(database))
      }),
    ),
  )

// The services over the store in the database; Effect drops its records below the level LogTape logs at, or below debug with --debug
function layerOf(
  options: KernelOptions,
  level: KernelLogLevel,
  database: string,
): Layer.Layer<Services> {
  const debug = options.logging === undefined ? undefined : options.logging.debug
  const layer = KernelLayer({ ...options, logLevel: effectLevelOf(level, debug) })
  return layer.pipe(Layer.provideMerge(privateStore(database)))
}

// The layer of the binary and of the daemon: the services over the database under the home of the user, with LogTape configured and the home made private
// The secrets go to the store the options give, else to the one the user configuration names
// The log level is resolved once, so LogTape and Effect's own minimum agree; what could not be made private is logged once logging is configured
export async function kernelBunLayer(options: KernelOptions): Promise<Layer.Layer<Services>> {
  const home = prepareHome(options.home)
  const level = await bootLevel(options)
  await configureKernelLogging({ ...options, logging: { ...options.logging, level } })
  warnAll(home.warnings)
  const secrets = await bootSecrets(options)
  return layerOf({ ...options, secrets }, level, path.join(home.data, 'bytebureau.db'))
}

// The kernel of the binary; the level is resolved before the layer, so the configuration is read once
export async function createKernel(options: KernelOptions): Promise<Kernel> {
  const level = await bootLevel(options)
  const resolved = { ...options, logging: { ...options.logging, level } }
  return createKernelFrom(await kernelBunLayer(resolved), resolved)
}
