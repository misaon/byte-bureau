import { describe, expect, it } from 'vitest'
import { definePlugin, type Plugin, type PluginManifest } from './plugin.js'

describe(definePlugin, () => {
  it('returns the plugin object unchanged so the host can read its manifest', () => {
    const testManifest: PluginManifest & {
      readonly contributes: Partial<
        Readonly<Record<'agentProviders' | 'workspaceRuntimes' | 'secretStores', readonly string[]>>
      >
    } = {
      name: 'example',
      version: '1.0.0',
      hostApi: '^0',
      kind: 'in-process',
      contributes: { agentProviders: ['example'] },
    }
    const plugin: Plugin = { manifest: testManifest, setup: () => ({}) }
    const result = definePlugin(plugin)
    expect(result).toBe(plugin)
    expect(testManifest.contributes.agentProviders).toStrictEqual(['example'])
  })

  it('typed plugins are assignable to the plugin registry', () => {
    interface MyConfig {
      readonly flag: boolean
    }
    const manifest: PluginManifest = {
      name: 'typed',
      version: '1.0.0',
      hostApi: '^0',
      kind: 'in-process',
    }
    const typedPlugin = definePlugin<MyConfig>({
      manifest,
      setup: (context): { readonly dispose: () => Promise<void> } => ({
        dispose: async (): Promise<void> => {
          await Promise.resolve(context.config.flag)
        },
      }),
    })
    const registry: readonly Plugin[] = [typedPlugin]
    expect(registry).toHaveLength(1)
  })
})
