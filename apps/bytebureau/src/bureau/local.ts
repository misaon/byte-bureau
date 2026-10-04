import type { Kernel } from '@bytebureau/kernel'
import type { EventEnvelope } from '@bytebureau/protocol'
import type { Bureau } from './bureau.js'

const ENDED: IteratorReturnResult<undefined> = { done: true, value: undefined }

// Settles once the signal aborts, at once when it has
const abortOf = async (signal: AbortSignal): Promise<IteratorReturnResult<undefined>> => {
  const { promise, resolve } = Promise.withResolvers<IteratorReturnResult<undefined>>()
  const end = (): void => {
    resolve(ENDED)
  }
  if (signal.aborted) {
    end()
  } else {
    signal.addEventListener('abort', end, { once: true })
  }
  const ended = await promise
  return ended
}

// The events until the signal aborts, as a subscription of the daemon ends: a wait for the next event ends then too, and the kernel's subscription with it
const untilAborted = (
  events: AsyncIterable<EventEnvelope>,
  signal: AbortSignal,
): AsyncIterable<EventEnvelope> => ({
  [Symbol.asyncIterator]: () => {
    const iterator = events[Symbol.asyncIterator]()
    const aborted = abortOf(signal)
    const end = async (): Promise<IteratorReturnResult<undefined>> => {
      if (iterator.return !== undefined) {
        await iterator.return()
      }
      return ENDED
    }
    return {
      next: async () => {
        const next = await Promise.race([iterator.next(), aborted])
        if (signal.aborted) {
          const ended = await end()
          return ended
        }
        return next
      },
      return: end,
    }
  },
})

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
    events: {
      subscribe: (filter, signal) => {
        const events = kernel.events.subscribe(filter)
        return signal === undefined ? events : untilAborted(events, signal)
      },
    },
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
