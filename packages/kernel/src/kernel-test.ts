import { Layer } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { UsageLayer } from './kernel-foundation.js'
import { composeKernel, type KernelLayerOptions, type KernelServices } from './kernel-live.js'
import { StoreTest } from './store/store-test.js'

// The layers of the kernel over an in-memory store; a test may swap in its own usage service
export const KernelTest = (
  options: KernelLayerOptions,
  usage?: UsageLayer,
): Layer.Layer<KernelServices | SqlClient.SqlClient> =>
  composeKernel(options, usage).pipe(Layer.provideMerge(StoreTest))

export { createTempRepo, git, tempDir } from './testing/temp-repo.js'
export { writeConfig } from './testing/repo-config.js'
