import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { serverUrl, type ServerInfo } from '@bytebureau/protocol'
import { onTestFinished } from 'vitest'
import { isAlive, lockHolder, readServerInfo } from '../daemon/server-info.js'
import { stopDaemon } from '../daemon/stop.js'
import { listening } from './listening.js'
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

// A foreground daemon of the home, run from source; killed when the test ends if it is still there
// The flags follow serve --no-daemonize: --port 0 unless the test names its own, as a daemon that reads its port from the home does
export async function startDaemonProcess(
  home: string,
  flags: readonly string[] = ['--port', '0'],
): Promise<DaemonProcess> {
  const child = spawn('bun', ['run', 'src/main.ts', 'serve', '--no-daemonize', ...flags], {
    cwd: CLI_DIRECTORY,
    env: childEnv({ BYTEBUREAU_HOME: home }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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

// A loopback port nothing listens on now, for daemons that must come and go on the same one
export async function freePort(): Promise<number> {
  const { port, close } = await listening(createServer())
  await close()
  return port
}

const ended = async (pid: number, deadline: number): Promise<boolean> => {
  const alive = isAlive(pid)
  if (!alive || Date.now() >= deadline) {
    return !alive
  }
  await sleep(100)
  return ended(pid, deadline)
}

// A pid that ended meanwhile has nothing left to signal
const signal = (pid: number, name: NodeJS.Signals): void => {
  try {
    process.kill(pid, name)
  } catch {
    // Gone already
  }
}

// The daemon of the home ends with the test: as --stop ends it, else through the pid of its lock, which a daemon holds from its start on
// One that does not end within the wait is killed; both waits together stay within the 10 s a test hook is given
export async function stopDaemonOf(home: string): Promise<void> {
  await stopDaemon(home, 4000)
  const holder = lockHolder(home)
  if (holder === undefined || !isAlive(holder)) {
    return
  }
  signal(holder, 'SIGTERM')
  if (!(await ended(holder, Date.now() + 4000))) {
    signal(holder, 'SIGKILL')
  }
}

// A daemon that a command starts on demand ends with the test, should an assertion fail before the test stops it
export function stoppedWithTheTest(home: string): void {
  onTestFinished(async () => {
    await stopDaemonOf(home)
  })
}
