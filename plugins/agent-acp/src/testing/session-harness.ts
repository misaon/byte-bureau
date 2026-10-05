import { spawn, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import type {
  AgentEvent,
  AgentProvider,
  AgentSession,
  AskAnswer,
  CreateSessionRequest,
  ExecHandle,
  ProcessSpawner,
} from '@bytebureau/plugin-api'
import { onTestFinished } from 'vitest'
import type { AcpDeps, SpawnFn } from '../process.js'
import { recordingLogger, type LogEntry } from './requests.js'

// An agent the adapter started, with what it was started with
interface Spawned {
  readonly child: ChildProcess
  readonly command: string
  readonly args: readonly string[]
  readonly options: SpawnOptionsWithoutStdio
}

export interface Harness {
  readonly deps: AcpDeps
  readonly logged: LogEntry[]
  readonly spawned: Spawned[]
  readonly terminals: ChildProcess[]
}

// Whatever of a process group is left when its test ends is killed; a child that leads none is killed alone
const killGroup = (child: ChildProcess): void => {
  try {
    process.kill(-(child.pid ?? 0), 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

// A process that still runs when its test ends is killed, its group with it, and waited for
const endNow = async (child: ChildProcess): Promise<void> => {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit')
    killGroup(child)
    await exit
  } else if (child.pid !== undefined) {
    killGroup(child)
  }
}

const isRunning = (pid: number): boolean => {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

// Whether a process is gone within the time given; a pid is polled, as nothing else tells of a grandchild
export const goneWithin = async (pid: number, limitMs: number): Promise<boolean> => {
  if (!isRunning(pid)) {
    return true
  }
  if (limitMs <= 0) {
    return false
  }
  await setTimeout(50)
  const gone = await goneWithin(pid, limitMs - 50)
  return gone
}

async function* linesOf(stream: Readable): AsyncIterable<string> {
  for await (const line of createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  })) {
    yield line
  }
}

// A process the test learnt of is killed when the test ends, should it outlive what the test checks
export const killedAtEnd = (pid: number): void => {
  onTestFinished(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone already
    }
  })
}

// The first line the first agent of a harness writes to stderr
export const firstWordOf = async ({ spawned }: Harness): Promise<string> => {
  const { promise, resolve } = Promise.withResolvers<string>()
  const [agent] = spawned
  if (agent !== undefined && agent.child.stderr !== null) {
    agent.child.stderr.once('data', (chunk: string) => {
      resolve(chunk.split('\n')[0] ?? '')
    })
  }
  const line = await promise
  return line
}

// The exit of a child that has started; the listener is set before anything can end it
export const exitOf = async (child: ChildProcess): Promise<Awaited<ExecHandle['exited']>> => {
  const { promise, resolve } = Promise.withResolvers<Awaited<ExecHandle['exited']>>()
  child.once('exit', (code, signal) => {
    resolve({ code, signal })
  })
  const exit = await promise
  return exit
}

// The end of a process; one that has already ended is not waited for
export const endOf = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode === null && child.signalCode === null) {
    await exitOf(child)
  }
}

// The process port of the plugin context as the tests give it: plain child processes, killed when the test ends
const nodeProcesses = (children: ChildProcess[]): ProcessSpawner => ({
  async spawn(spec) {
    const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: { ...spec.env } })
    children.push(child)
    await once(child, 'spawn')
    const exited = exitOf(child)
    return {
      pid: child.pid ?? -1,
      stdout: linesOf(child.stdout),
      stderr: linesOf(child.stderr),
      exited,
      kill(signal = 'SIGTERM') {
        child.kill(signal)
      },
    }
  },
})

// Deps whose spawn runs the real agent and records it, with every process ended when the test ends
export const harness = (): Harness => {
  const spawned: Spawned[] = []
  const terminals: ChildProcess[] = []
  const { logger, entries } = recordingLogger()
  const recording: SpawnFn = (command, args, options) => {
    const child = spawn(command, args, options)
    spawned.push({ child, command, args, options })
    return child
  }
  onTestFinished(async () => {
    const children = [...spawned.map(({ child }) => child), ...terminals]
    await Promise.all(
      children.map(async (child) => {
        await endNow(child)
      }),
    )
  })
  const deps: AcpDeps = { spawn: recording, process: nodeProcesses(terminals), logger }
  return { deps, logged: entries, spawned, terminals }
}

// A session closed when its test ends, whatever happened in it
export const started = async (
  provider: AgentProvider,
  request: CreateSessionRequest,
): Promise<AgentSession> => {
  const session = await provider.createSession(request)
  onTestFinished(async () => {
    await session.close()
  })
  return session
}

// The events of a session up to the first of the type, that one included; an ask is answered as it comes when an answer is given
export const until = async (
  session: AgentSession,
  type: AgentEvent['type'],
  answer?: AskAnswer,
): Promise<AgentEvent[]> => {
  const seen: AgentEvent[] = []
  for await (const event of session.events()) {
    seen.push(event)
    if (event.type === 'ask.requested' && answer !== undefined) {
      await session.answer(event.ask.id, answer)
    }
    if (event.type === type) {
      break
    }
  }
  return seen
}

// Every event a session still has to tell, up to its end
export const rest = async (session: AgentSession): Promise<AgentEvent[]> => {
  const seen: AgentEvent[] = []
  for await (const event of session.events()) {
    seen.push(event)
  }
  return seen
}
