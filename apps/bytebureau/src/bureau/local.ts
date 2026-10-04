import type { Kernel } from '@bytebureau/kernel'
import type { Bureau } from './bureau.js'

// The kernel of this process as a Bureau; the answers given through it are the CLI's
// It started when the Bureau was made, which is the start its health tells of
export const localBureau = (kernel: Kernel, version: string): Bureau => {
  const startedAt = new Date().toISOString()
  return {
    projects: kernel.projects,
    sessions: kernel.sessions,
    asks: {
      pending: kernel.asks.pending,
      get: kernel.asks.get,
      answer: async (askId, answer) => {
        await kernel.asks.answer(askId, answer, 'cli')
      },
    },
    events: { subscribe: (filter) => kernel.events.subscribe(filter) },
    workspaces: kernel.workspaces,
    usage: kernel.usage,
    plugins: {
      list: async () => {
        const listed = await Promise.resolve(kernel.plugins.list())
        return listed
      },
      providers: async () => {
        const providers = await Promise.resolve(kernel.providers.list())
        return providers
      },
    },
    health: {
      check: async () => {
        const report = await kernel.health.check()
        return { ...report, version, startedAt }
      },
    },
    where: { kind: 'in-process' },
    close: kernel.close,
  }
}
