import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { serverUrl, type ServerInfo } from '@bytebureau/protocol'
import { onTestFinished } from 'vitest'
import { readServerInfo } from '../daemon/server-info.js'
import { childEnv } from './run-cli.js'

const CLI_DIRECTORY = fileURLToPath(new URL('../..', import.meta.url))

export interface DaemonProcess {
  readonly info: ServerInfo
  readonly url: string
  readonly child: ChildProcess
  readonly stdout: () => string
  readonly stderr: () => string
  // SIGTERM, then the exit code of the daemon
  readonly stop: () => Promise<number | null>
}

interface Output {
  stdout: string
  stderr: string
}

const captured = (child: ChildProcess): Output => {
  const output: Output = { stdout: '', stderr: '' }
  if (child.stdout !== null) {
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output.stdout += chunk
    })
  }
  if (child.stderr !== null) {
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output.stderr += chunk
    })
  }
  return output
}

// The record the daemon of the child writes once it serves; nothing when the child ended first or took too long
const recordOf = async (
  home: string,
  child: ChildProcess,
  deadline: number,
): Promise<ServerInfo | undefined> => {
  const record = readServerInfo(home)
  if (record.state === 'alive' && record.info.pid === child.pid) {
    return record.info
  }
  if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
    return undefined
  }
  await sleep(100)
  return recordOf(home, child, deadline)
}

// A foreground daemon on a free port of the home, run from source; killed when the test ends if it is still there
export async function startDaemonProcess(
  home: string,
  extra: readonly string[] = [],
): Promise<DaemonProcess> {
  const child = spawn(
    'bun',
    ['run', 'src/main.ts', 'serve', '--no-daemonize', '--port', '0', ...extra],
    {
      cwd: CLI_DIRECTORY,
      env: childEnv({ BYTEBUREAU_HOME: home }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  onTestFinished(() => {
    child.kill('SIGKILL')
  })
  const output = captured(child)
  const { promise: exited, resolve } = Promise.withResolvers<number | null>()
  child.once('close', (code) => {
    resolve(code)
  })
  const info = await recordOf(home, child, Date.now() + 15_000)
  if (info === undefined) {
    throw new Error(`the daemon did not write server.json in time: ${output.stderr}`)
  }
  const stop = async (): Promise<number | null> => {
    child.kill('SIGTERM')
    const code = await exited
    return code
  }
  return {
    info,
    url: serverUrl(info),
    child,
    stdout: () => output.stdout,
    stderr: () => output.stderr,
    stop,
  }
}
