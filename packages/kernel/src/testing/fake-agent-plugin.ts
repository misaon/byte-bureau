import { definePlugin, type Plugin } from '@bytebureau/plugin-api'
import { FakeAgentProvider } from './fake-agent-provider.js'

export const fakeAgentPlugin: Plugin = definePlugin({
  manifest: {
    name: 'agent-fake',
    version: '0.0.0',
    displayName: 'Fake agent',
    hostApi: '^0',
    kind: 'in-process',
    contributes: { agentProviders: ['fake'] },
  },
  setup: () => ({ agentProviders: [new FakeAgentProvider()] }),
})
