import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import type { ExecHandle, ExecSpec, ProcessSpawner } from '@bytebureau/plugin-api'

type Exit = Awaited<ExecHandle['exited']>

// A contributor's global git configuration must not reach the git that a test runs
const ISOLATED_GIT = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } as const

async function* lines(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
  if (stream === null) {
    return
  }
  for await (const line of createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY,
  })) {
    yield line
  }
}

interface Watched {
  readonly started: Promise<unknown>
  readonly closed: Promise<unknown>
  readonly failures: readonly Error[]
}

// The events of a child as plain ones: events.once rejects on an 'error' event, but here a command that cannot start is a result
function watch(child: ChildProcess): Watched {
  const events = new EventTarget()
  const failures: Error[] = []
  const started = once(events, 'started')
  const closed = once(events, 'closed')
  child.once('spawn', () => {
    events.dispatchEvent(new Event('started'))
  })
  child.on('error', (error) => {
    failures.push(error)
    events.dispatchEvent(new Event('started'))
  })
  child.on('close', () => {
    events.dispatchEvent(new Event('closed'))
  })
  return { started, closed, failures }
}

async function exitOf(child: ChildProcess, closed: Promise<unknown>): Promise<Exit> {
  await closed
  // A command that could not start never had a process; the kernel reports that as exit -1
  if (child.pid === undefined) {
    return { code: -1, signal: null }
  }
  return { code: child.exitCode, signal: child.signalCode }
}

// The reasons a command could not start, one per line, as a stream of its own
function reasonsOf(failures: readonly Error[]): Readable {
  return Readable.from(failures.map((failure) => `${failure.message}\n`))
}

function handleOf(child: ChildProcess, watched: Watched): ExecHandle {
  const running = child.pid !== undefined
  return {
    pid: child.pid ?? -1,
    stdout: running ? lines(child.stdout) : lines(null),
    stderr: running ? lines(child.stderr) : lines(reasonsOf(watched.failures)),
    exited: exitOf(child, watched.closed),
    kill(signal = 'SIGTERM') {
      child.kill(signal)
    },
  }
}

// Read the lines right after spawning: node drops the output of a process that has exited before anybody reads it
export const nodeSpawner: ProcessSpawner = {
  async spawn(spec: ExecSpec & { readonly cwd: string }): Promise<ExecHandle> {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...ISOLATED_GIT, ...spec.env },
      signal: spec.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const watched = watch(child)
    await watched.started
    return handleOf(child, watched)
  },
}
