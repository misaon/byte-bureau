import { Effect, Layer } from 'effect'
import type { UsageLayer } from '../kernel-foundation.js'
import { KernelTest, type KernelLayerOptions } from '../kernel-live.js'
import { emptyHome } from '../projects/project-registry-fixtures.js'
import type { SessionServices } from './session-services.js'

// The kernel as the session tests run it: the bundled plugins, an in-memory store and an empty home that goes with the layer
export const sessionLayer = (
  options: Omit<KernelLayerOptions, 'home'> = {},
  usage?: UsageLayer,
): Layer.Layer<SessionServices> =>
  Layer.unwrap(emptyHome.pipe(Effect.map((home) => KernelTest({ ...options, home }, usage))))

// The same layer with more plugins, such as an agent a test drives, and the usage service a test wants
export const withPlugins = (
  plugins: NonNullable<KernelLayerOptions['extraPlugins']>,
  usage?: UsageLayer,
): Layer.Layer<SessionServices> => sessionLayer({ extraPlugins: plugins }, usage)
