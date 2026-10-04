import { setTimeout as sleep } from 'node:timers/promises'
import { m } from '@bytebureau/i18n'
import type { ServerInfo } from '@bytebureau/protocol'
import { JUDGING, judgeHolder, type Judging } from './lock-holder.js'
import { heldLock } from './lock.js'
import { lockPath } from './server-info.js'
import { daemonLogPath } from './daemon-log.js'
import { spawnDaemon, type DaemonChild } from './spawn.js'
import { runningDaemon } from './wait.js'

export type Started =
  | { readonly up: true; readonly info: ServerInfo }
  // The line that tells why, naming the log or the lock
  | { readonly up: false; readonly reason: string }

// A start that takes longer is given up on; one whose process ends says why at once
const START_MS = 30_000

export interface Starting {
  readonly home: string
  readonly child: DaemonChild
  readonly limitMs?: number | undefined
  readonly judging?: Judging | undefined
}

// Why a start whose process has ended failed; nothing while the daemon of the home that holds the lock is on its way up, such as one a racing start made
const failureOf = async (home: string, judging: Judging): Promise<string | undefined> => {
  const held = heldLock(home)
  const holder = held === undefined ? 'gone' : await judgeHolder(home, held, judging)
  if (holder === 'daemon') {
    return undefined
  }
  if (holder === 'stuck' && held !== undefined && held.pid !== undefined) {
    return m.serve_lock_stuck({ lock: lockPath(home), pid: held.pid })
  }
  return m.serve_failed({ log: daemonLogPath(home) })
}

const awaited = async (
  home: string,
  child: DaemonChild,
  until: Judging & { readonly deadline: number },
): Promise<Started> => {
  const running = await runningDaemon(home)
  if (running !== undefined) {
    return { up: true, info: running }
  }
  const failure = child.ended() ? await failureOf(home, until) : undefined
  if (failure !== undefined) {
    return { up: false, reason: failure }
  }
  if (Date.now() >= until.deadline) {
    return { up: false, reason: m.serve_timeout({ log: daemonLogPath(home) }) }
  }
  await sleep(100)
  return awaited(home, child, until)
}

/**
 * Waits for the daemon a start made: up once the daemon of the home answers, whichever start made it.
 * A start whose process ended is a failure at once, naming the log, or the lock with the way out when a process that is no
 * daemon of the home and not this user's holds it; while the daemon that holds the lock is on its way up, the wait goes on.
 */
export const awaitStart = async ({
  home,
  child,
  limitMs = START_MS,
  judging = JUDGING,
}: Starting): Promise<Started> => {
  const started = await awaited(home, child, { ...judging, deadline: Date.now() + limitMs })
  return started
}

// The daemon of the home, started detached with the environment and the flags given, and waited for
export const startDetached = async (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  extra: readonly string[],
): Promise<Started> => {
  const child = spawnDaemon(home, env, extra)
  const started = await awaitStart({ home, child })
  return started
}
