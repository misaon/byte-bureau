import type { BureauClient } from '@bytebureau/client'
import type { EventEnvelope } from '@bytebureau/protocol'
import { ASK, HEALTH, PROJECT, SESSION, TURN } from './records.js'

// The calls a client was asked, each its name and its arguments
export type Calls = unknown[][]

const USAGE = { turns: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.002, contextPct: 3 }

// A function of the client that remembers how it was called and answers with the value
const answering =
  <Value>(calls: Calls, name: string, value: Value) =>
  async (...args: readonly unknown[]): Promise<Value> => {
    calls.push([name, ...args])
    await Promise.resolve()
    return value
  }

// The same for a command the daemon answers with no content
const doing =
  (calls: Calls, name: string) =>
  async (...args: readonly unknown[]): Promise<void> => {
    calls.push([name, ...args])
    await Promise.resolve()
  }

async function* noEvents(): AsyncGenerator<EventEnvelope> {
  await Promise.resolve()
  yield* []
}

// The calls of the client that come back with a record of the daemon
const recordsOf = (calls: Calls): Pick<BureauClient, 'projects' | 'sessions'> => ({
  projects: {
    list: answering(calls, 'projects.list', [PROJECT]),
    register: answering(calls, 'projects.register', PROJECT),
    get: answering(calls, 'projects.get', PROJECT),
    remove: doing(calls, 'projects.remove'),
  },
  sessions: {
    list: answering(calls, 'sessions.list', [SESSION]),
    create: answering(calls, 'sessions.create', SESSION),
    get: answering(calls, 'sessions.get', SESSION),
    prompt: answering(calls, 'sessions.prompt', TURN),
    interrupt: doing(calls, 'sessions.interrupt'),
    stop: doing(calls, 'sessions.stop'),
    resume: answering(calls, 'sessions.resume', SESSION),
    complete: doing(calls, 'sessions.complete'),
  },
})

// A client of no daemon at all: it remembers what it was asked
export const recordingClient = (calls: Calls): BureauClient => ({
  ...recordsOf(calls),
  asks: {
    pending: answering(calls, 'asks.pending', [ASK]),
    get: answering(calls, 'asks.get', ASK),
    answer: doing(calls, 'asks.answer'),
  },
  usage: { session: answering(calls, 'usage.session', USAGE) },
  workspaces: {
    list: answering(calls, 'workspaces.list', []),
    prune: answering(calls, 'workspaces.prune', { removed: [], retained: [] }),
  },
  plugins: {
    list: answering(calls, 'plugins.list', []),
    providers: answering(calls, 'plugins.providers', []),
  },
  health: { check: answering(calls, 'health.check', HEALTH) },
  events: {
    subscribe: (filter, options) => {
      calls.push(['events.subscribe', filter, options])
      return noEvents()
    },
  },
  rpc: {
    connect: async () => {
      await Promise.resolve()
      throw new Error('no RPC in this test')
    },
  },
  close: doing(calls, 'close'),
})
