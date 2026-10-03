import path from 'node:path'
import { Layer } from 'effect'
import { bootLevel } from './facade/boot-logging.js'
import { createKernelFrom, type Kernel, type KernelOptions } from './facade.js'
import { KernelLayer } from './kernel-live.js'
import { effectLevelOf } from './logging/logging.js'
import { prepareHome, restrictDatabase } from './store/home.js'
import { StoreLive } from './store/store-live.js'

export { StoreLive } from './store/store-live.js'
export type { Kernel, KernelOptions } from './facade.js'

// The kernel of the binary: its store is the database under the home of the user, which only the user can read
// The log level is resolved once, so LogTape and Effect's own minimum agree; --debug lowers Effect's minimum to debug
export async function createKernel(options: KernelOptions): Promise<Kernel> {
  const database = path.join(prepareHome(options.home), 'bytebureau.db')
  const level = await bootLevel(options)
  const debug = options.logging === undefined ? undefined : options.logging.debug
  const layer = KernelLayer({ ...options, logLevel: effectLevelOf(level, debug) })
  const store = StoreLive(database)
  const logging = { ...options.logging, level }
  const kernel = await createKernelFrom(layer.pipe(Layer.provideMerge(store)), {
    ...options,
    logging,
  })
  restrictDatabase(database)
  return kernel
}
