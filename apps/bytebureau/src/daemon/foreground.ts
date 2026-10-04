import { PortInUseError, startDaemon, type RunningDaemon } from '@bytebureau/api/bun'
import { m } from '@bytebureau/i18n'
import type { Context } from '../context.js'
import { version } from '../version.js'
import { acquireLock, releaseLock, type LockOutcome } from './lock.js'
import { publish } from './publish.js'
import { lockPath, removeServerInfoIf } from './server-info.js'
import { tokenFor } from './token.js'

export interface ForegroundOptions {
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly host?: string | undefined
  readonly port?: number | undefined
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

// Resolves at the first of the signals; the next one does what it did before (it ends the process), so a stuck shutdown can be cut short
async function signalled(): Promise<NodeJS.Signals> {
  const { promise, resolve } = Promise.withResolvers<NodeJS.Signals>()
  const settle = (signal: NodeJS.Signals): void => {
    for (const name of SIGNALS) {
      process.off(name, settle)
    }
    resolve(signal)
  }
  for (const name of SIGNALS) {
    process.on(name, settle)
  }
  const signal = await promise
  return signal
}

// The daemon of this process, or nothing when its port is taken, which is said in one line
async function started(
  options: ForegroundOptions,
  token: string,
  context: Context,
): Promise<RunningDaemon | undefined> {
  try {
    return await startDaemon({ ...options, version, token, logging: context.logging })
  } catch (error) {
    if (!(error instanceof PortInUseError)) {
      throw error
    }
    context.output.warn(error.message)
    return undefined
  }
}

// Only the record of this daemon goes: one a daemon that took the lock over has written since is that daemon's
async function closed(daemon: RunningDaemon, home: string): Promise<void> {
  try {
    await daemon.close()
  } finally {
    removeServerInfoIf(
      home,
      (record) =>
        record.state !== 'absent' && record.info !== undefined && record.info.pid === process.pid,
    )
  }
}

// The record exists from the moment the server is bound to the moment it is gone
// The signals are listened for before it exists, so the first one always ends the daemon cleanly, one during the start included
async function serveLocked(options: ForegroundOptions, context: Context): Promise<number> {
  const stopped = signalled()
  const token = tokenFor(options.home)
  const daemon = await started(options, token, context)
  if (daemon === undefined) {
    return 1
  }
  try {
    publish(options.home, { daemon, token }, context)
    await stopped
  } finally {
    await closed(daemon, options.home)
  }
  return 0
}

// Why the lock went to another: a daemon of the home has it, or a process that is no daemon of the home and not this user's to take it from
const refusal = (lock: Extract<LockOutcome, { acquired: false }>, home: string): string =>
  lock.stuck
    ? m.serve_lock_stuck({ lock: lockPath(home), pid: lock.pid })
    : `a daemon is already running (pid ${lock.pid})`

// Runs until SIGINT, SIGTERM or SIGHUP; one daemon per home, which the lock decides atomically, naming the pid of the one that holds it
export async function serveForeground(
  options: ForegroundOptions,
  context: Context,
): Promise<number> {
  const lock = await acquireLock(options.home)
  if (!lock.acquired) {
    context.output.warn(refusal(lock, options.home))
    return 1
  }
  try {
    return await serveLocked(options, context)
  } finally {
    releaseLock(options.home)
  }
}
