import type { BureauClient } from '@bytebureau/client'
import type { Bureau } from './bureau.js'

// The daemon as a Bureau: every call is one request; a lookup the API answers 404 to is undefined here
export const remoteBureau = (client: BureauClient, url: string): Bureau => ({
  projects: {
    ...client.projects,
    register: async (path) => {
      const project = await client.projects.register({ path })
      return project
    },
  },
  sessions: client.sessions,
  asks: client.asks,
  // A run gives up on a daemon that stays unreachable for fifteen seconds; the next start of the daemon stops the session
  events: {
    subscribe: (filter, signal) => client.events.subscribe(filter, { signal, retryFor: 15_000 }),
  },
  workspaces: client.workspaces,
  usage: client.usage,
  plugins: client.plugins,
  health: client.health,
  where: { kind: 'daemon', url },
  close: client.close,
})
