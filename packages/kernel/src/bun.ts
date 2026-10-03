import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { Layer } from 'effect'
import { createKernelFrom, type Kernel, type KernelOptions } from './facade.js'
import { KernelLayer } from './kernel-live.js'
import { parseLogLevel } from './logging/logging.js'
import { StoreLive } from './store/store-live.js'

export { StoreLive } from './store/store-live.js'
export type { Kernel, KernelOptions } from './facade.js'

// The kernel of the binary: its store is the database under the home of the user
export async function createKernel(options: KernelOptions): Promise<Kernel> {
  const dataDir = path.join(options.home, 'data')
  mkdirSync(dataDir, { recursive: true })
  const { level } = options.logging ?? {}
  const layer = KernelLayer({ ...options, logLevel: parseLogLevel(level) })
  const store = StoreLive(path.join(dataDir, 'bytebureau.db'))
  const kernel = await createKernelFrom(layer.pipe(Layer.provideMerge(store)), options)
  return kernel
}
