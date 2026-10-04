import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import { daemonExecArgs } from './exec-args.js'

export const daemonLogPath = (home: string): string => path.join(home, 'logs', 'daemon.log')

// The process of a daemon started detached, as far as its starter follows it
export interface DaemonChild {
  // True once the process has ended, which a daemon that serves never does
  readonly ended: () => boolean
}

// The end of the process, which this one does not wait for
const followed = (child: ChildProcess): DaemonChild => {
  const state = { ended: false }
  const end = (): void => {
    state.ended = true
  }
  child.once('exit', end).once('error', end)
  child.unref()
  return { ended: () => state.ended }
}

// The daemon starts in its own process group with nothing of this terminal: its output goes to the log of the home
// The child holds its own copy of the log, so this process lets go of its own at once
export const spawnDaemon = (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  extra: readonly string[],
): DaemonChild => {
  mkdirSync(path.dirname(daemonLogPath(home)), { recursive: true, mode: 0o700 })
  const log = openSync(daemonLogPath(home), 'a', 0o600)
  try {
    const { command, args } = daemonExecArgs(process, extra)
    const child = spawn(command, args, {
      detached: true,
      // Bun moves a detached child without a cwd to $HOME (Bun issue 44372): the home is as good a place as any
      cwd: home,
      stdio: ['ignore', log, log],
      env: { ...env, BYTEBUREAU_HOME: home },
      // No console window of its own on Windows; ignored elsewhere
      windowsHide: true,
    })
    return followed(child)
  } finally {
    closeSync(log)
  }
}
