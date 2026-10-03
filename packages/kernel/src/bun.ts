import path from 'node:path'
import { Layer } from 'effect'
import { bootLevel } from './facade/boot-logging.js'
import type { Services } from './facade/promised.js'
import { createKernelFrom, type Kernel, type KernelOptions } from './facade.js'
import { KernelLayer } from './kernel-live.js'
import { effectLevelOf, kernelLogger, type KernelLogLevel } from './logging/logging.js'
import { prepareHome, restrictDatabase } from './store/home.js'
import { StoreLive } from './store/store-live.js'

export { StoreLive } from './store/store-live.js'
export type { Kernel, KernelOptions } from './facade.js'

// The services over the store in the database; Effect drops its records below the level LogTape logs at, or below debug with --debug
function layerOf(
  options: KernelOptions,
  level: KernelLogLevel,
  database: string,
): Layer.Layer<Services> {
  const debug = options.logging === undefined ? undefined : options.logging.debug
  const layer = KernelLayer({ ...options, logLevel: effectLevelOf(level, debug) })
  return layer.pipe(Layer.provideMerge(StoreLive(database)))
}

// The kernel of the binary: its store is the database under the home of the user, which only the user can read
// The log level is resolved once, so LogTape and Effect's own minimum agree; what could not be made private is logged once logging is configured
export async function createKernel(options: KernelOptions): Promise<Kernel> {
  const home = prepareHome(options.home)
  const database = path.join(home.data, 'bytebureau.db')
  const level = await bootLevel(options)
  const logging = { ...options.logging, level }
  const kernel = await createKernelFrom(layerOf(options, level, database), { ...options, logging })
  const logger = kernelLogger(['bb', 'store'])
  for (const warning of [...home.warnings, ...restrictDatabase(database)]) {
    logger.warn(warning)
  }
  return kernel
}
