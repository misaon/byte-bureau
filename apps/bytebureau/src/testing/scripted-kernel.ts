import type { AskAnswer, EventEnvelope } from '@bytebureau/protocol'
import { vi } from 'vitest'
import type { Bureau } from '../bureau/bureau.js'
import type { RunOptions } from '../commands/run-session.js'
import { createContext, type Context } from '../context.js'
import { event } from './events.js'
import { PROJECT, SESSION, TURN } from './records.js'

interface Answered {
  readonly askId: string
  readonly answer: AskAnswer
}

export interface Scripted {
  readonly bureau: Bureau
  // What the run asked of the Bureau, in order
  readonly calls: string[]
  readonly answered: Answered[]
}

export interface Overrides {
  readonly register?: Bureau['projects']['register']
  readonly create?: Bureau['sessions']['create']
  readonly prompt?: Bureau['sessions']['prompt']
  readonly stop?: Bureau['sessions']['stop']
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

// A function that fails the way the kernel or the daemon does
export function rejecting(failure: Error): () => Promise<never> {
  return async () => {
    await Promise.resolve()
    throw failure
  }
}

// What a run never asks of the Bureau
const notScripted = (): (() => Promise<never>) => rejecting(new Error('not scripted'))

function sessionsOf(calls: string[], overrides: Overrides): Bureau['sessions'] {
  return {
    create:
      overrides.create ??
      (async (body) => {
        calls.push(`create ${body.title}`)
        await Promise.resolve()
        return SESSION
      }),
    prompt:
      overrides.prompt ??
      (async (sessionId, input) => {
        calls.push(`prompt ${sessionId} ${input.text}`)
        await Promise.resolve()
        return TURN
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
    interrupt: notScripted(),
    resume: notScripted(),
    list: notScripted(),
    get: notScripted(),
  }
}

function projectsOf(calls: string[], overrides: Overrides): Bureau['projects'] {
  return {
    register:
      overrides.register ??
      (async (path) => {
        calls.push(`register ${path}`)
        await Promise.resolve()
        return PROJECT
      }),
    list: notScripted(),
    get: notScripted(),
    remove: notScripted(),
  }
}

// The rest of a Bureau, which a run asks nothing of but the providers
const unscripted: Pick<Bureau, 'health' | 'plugins' | 'usage' | 'workspaces' | 'where' | 'close'> =
  {
    workspaces: { list: notScripted(), prune: notScripted() },
    usage: { session: notScripted() },
    plugins: {
      list: notScripted(),
      providers: async () => {
        await Promise.resolve()
        return [{ id: 'fake', displayName: 'Fake agent' }]
      },
    },
    health: { check: notScripted() },
    where: { kind: 'in-process' },
    close: notScripted(),
  }

// A Bureau that records what it is asked and tells the events of the script, whatever the run does
export function scripted(events: readonly EventEnvelope[], overrides: Overrides = {}): Scripted {
  const calls: string[] = []
  const answered: Answered[] = []
  const bureau: Bureau = {
    ...unscripted,
    projects: projectsOf(calls, overrides),
    sessions: sessionsOf(calls, overrides),
    asks: {
      pending: notScripted(),
      get: notScripted(),
      answer: async (askId, answer) => {
        answered.push({ askId, answer })
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
  return { bureau, calls, answered }
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

// What the terminal is written: clack draws its frame there, not through the console
export function captureTerminal(): () => string {
  const written: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk))
    return true
  })
  return () => written.join('')
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
