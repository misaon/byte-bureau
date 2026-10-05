import { query } from '@anthropic-ai/claude-agent-sdk'
import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { ClaudeAgentProvider } from './provider.js'

export type { ClaudeConfig } from './config.js'
export { CLAUDE_CONVENTIONS } from './options.js'
export type { ClaudeDeps, QueryFn } from './deps.js'
export { ClaudeAgentProvider } from './provider.js'

export const claudeAgentPlugin: Plugin = definePlugin({
  manifest: {
    name: 'agent-claude',
    version: '0.0.0',
    displayName: 'Claude Code (Agent SDK)',
    hostApi: '^0',
    kind: 'in-process',
    capabilities: ['process', 'net', 'secrets'],
    contributes: { agentProviders: ['claude'] },
  },
  setup(context) {
    return { agentProviders: [new ClaudeAgentProvider({ query, logger: context.logger })] }
  },
})
