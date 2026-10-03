import type { Hooks } from '@bytebureau/plugin-api'
import type { Layer } from 'effect'
import type { UsageLayer } from '../kernel-foundation.js'
import {
  scriptedPlugin,
  scriptedProvider,
  type Behaviour,
  type Scripted,
} from '../testing/scripted-provider.js'
import { withPlugins, type SessionServices } from './session-layer-fixtures.js'

// A provider a test drives, and the layer that offers it beside the bundled plugins
export interface Driven {
  readonly scripted: Scripted
  readonly layer: Layer.Layer<SessionServices>
}

// The usage service is the live one unless a test gives its own
export const driven = (
  behaviour: Behaviour = {},
  hooks: Partial<Hooks> = {},
  usage?: UsageLayer,
): Driven => {
  const scripted = scriptedProvider('scripted', behaviour)
  return { scripted, layer: withPlugins([scriptedPlugin(scripted, hooks)], usage) }
}
