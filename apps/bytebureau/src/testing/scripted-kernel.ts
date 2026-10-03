import type { AnsweredVia, AskAnswer, EventEnvelope } from '@bytebureau/protocol'
import { vi } from 'vitest'
import { createContext, type Context } from '../context.js'
import type { RunKernel, RunOptions } from '../commands/run-session.js'
import { event } from './events.js'

interface Answered {
  readonly askId: string
  readonly answer: AskAnswer
  readonly via: AnsweredVia
}

export interface Scripted {
  readonly kernel: RunKernel
  // What the run asked of the kernel, in order
  readonly calls: string[]
  readonly answered: Answered[]
}

export interface Overrides {
  readonly register?: RunKernel['projects']['register']
  readonly create?: RunKernel['sessions']['create']
  readonly prompt?: RunKernel['sessions']['prompt']
  readonly stop?: RunKernel['sessions']['stop']
  // The events do not come before the gate is open
  readonly gate?: Promise<boolean>
}

// A promise that the test opens by hand
export function latch(): { readonly opened: Promise<boolean>; readonly open: () => void } {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  return {
    opened: promise,
    open: () => {
      resolve(true)
    },
  }
}

async function* replay(
  events: readonly EventEnvelope[],
  gate: Promise<boolean>,
): AsyncGenerator<EventEnvelope> {
  await gate
  yield* events
}

// A function that fails the way the kernel does
export function rejecting(failure: Error): () => Promise<never> {
  return async () => {
    await Promise.resolve()
    throw failure
  }
}

function sessionsOf(calls: string[], overrides: Overrides): RunKernel['sessions'] {
  return {
    create:
      overrides.create ??
      (async (input) => {
        calls.push(`create ${input.title}`)
        await Promise.resolve()
        return { id: 's1' }
      }),
    prompt:
      overrides.prompt ??
      (async (sessionId, input) => {
        calls.push(`prompt ${sessionId} ${input.text}`)
        await Promise.resolve()
      }),
    stop:
      overrides.stop ??
      (async (sessionId) => {
        calls.push(`stop ${sessionId}`)
        await Promise.resolve()
      }),
    complete: async (sessionId) => {
      calls.push(`complete ${sessionId}`)
      await Promise.resolve()
    },
  }
}

// A kernel that records what it is asked and tells the events of the script, whatever the run does
export function scripted(events: readonly EventEnvelope[], overrides: Overrides = {}): Scripted {
  const calls: string[] = []
  const answered: Answered[] = []
  const kernel: RunKernel = {
    providers: { list: () => [{ id: 'fake' }] },
    projects: {
      register:
        overrides.register ??
        (async (path) => {
          calls.push(`register ${path}`)
          await Promise.resolve()
          return { id: 'p1' }
        }),
    },
    sessions: sessionsOf(calls, overrides),
    asks: {
      answer: async (askId, answer, via) => {
        answered.push({ askId, answer, via })
        await Promise.resolve()
      },
    },
    events: {
      subscribe: (filter) => {
        calls.push(`subscribe ${JSON.stringify(filter)}`)
        return replay(events, overrides.gate ?? Promise.resolve(true))
      },
    },
  }
  return { kernel, calls, answered }
}

// The context of a run: machine-readable or not, at a terminal or not
export function contextOf(json = false, terminal = false): Context {
  return createContext({ json, color: false, yes: false }, {}, terminal)
}

// What the run prints; the console is the test's until the test is over
export function captureConsole(): { readonly out: () => string[]; readonly err: () => string[] } {
  const log = vi.spyOn(console, 'log').mockReturnValue()
  const error = vi.spyOn(console, 'error').mockReturnValue()
  return {
    out: () => log.mock.calls.map(([line]) => String(line)),
    err: () => error.mock.calls.map(([line]) => String(line)),
  }
}

export const OPTIONS: RunOptions = { prompt: 'Fix the build', project: '/repo', yes: false }

export const TURN_DONE = event(
  'turn.completed',
  {
    turnId: 'u1',
    index: 0,
    status: 'completed',
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
  },
  2,
)
export const COMPLETED = event('session.completed', { status: 'completed' }, 3)
export const STOPPED = event('session.stopped', { status: 'stopped' }, 3)
export const ERRORED = event(
  'session.errored',
  { status: 'errored', kind: 'crash', message: 'the agent died', retryable: false },
  3,
)
