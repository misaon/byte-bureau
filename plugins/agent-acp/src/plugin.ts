import { spawn } from 'node:child_process'
import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import type { PresetId } from './presets.js'
import { AcpAgentProvider } from './provider.js'

export type { Preset, PresetId } from './presets.js'
export { PRESETS } from './presets.js'
export type { AcpDeps, SpawnFn } from './process.js'
export { AcpAgentProvider } from './provider.js'
export { AcpSession } from './session.js'

const PRESET_IDS: readonly PresetId[] = ['codex', 'gemini', 'opencode', 'pi', 'custom']

export const acpAgentPlugin: Plugin = definePlugin({
  manifest: {
    name: 'agent-acp',
    version: '0.0.0',
    displayName: 'ACP agents',
    hostApi: '^0',
    kind: 'in-process',
    capabilities: ['process', 'fs:read', 'fs:write', 'net'],
    contributes: {
      agentProviders: ['acp:codex', 'acp:gemini', 'acp:opencode', 'acp:pi', 'acp:custom'],
    },
  },
  setup(context) {
    const deps = { spawn, process: context.process, logger: context.logger }
    return { agentProviders: PRESET_IDS.map((preset) => new AcpAgentProvider(preset, deps)) }
  },
})
