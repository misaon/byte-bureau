import { PortInUseError, startDaemon, type RunningDaemon } from '@bytebureau/api/bun'
import type { ServerInfo } from '@bytebureau/protocol'
import type { Context } from '../context.js'
import { version } from '../version.js'
import { announce } from './announce.js'
import { acquireLock, releaseLock, removeServerInfo, writeServerInfo } from './server-info.js'
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

// What server.json says of the daemon of this process
const recordOf = (daemon: RunningDaemon, token: string): ServerInfo => ({
  version,
  host: daemon.address.host,
  port: daemon.address.port,
  pid: process.pid,
  token,
  startedAt: daemon.startedAt,
})

// From here on clients find the daemon
const publish = (home: string, info: ServerInfo, context: Context): void => {
  writeServerInfo(home, info)
  announce(info, context)
}

async function closed(daemon: RunningDaemon, home: string): Promise<void> {
  try {
    await daemon.close()
  } finally {
    removeServerInfo(home)
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
    publish(options.home, recordOf(daemon, token), context)
    await stopped
  } finally {
    await closed(daemon, options.home)
  }
  return 0
}

// Runs until SIGINT, SIGTERM or SIGHUP; one daemon per home, which the lock decides atomically, naming the pid of the one that holds it
export async function serveForeground(
  options: ForegroundOptions,
  context: Context,
): Promise<number> {
  const lock = acquireLock(options.home)
  if (!lock.acquired) {
    context.output.warn(`a daemon is already running (pid ${lock.pid})`)
    return 1
  }
  try {
    return await serveLocked(options, context)
  } finally {
    releaseLock(options.home)
  }
}
