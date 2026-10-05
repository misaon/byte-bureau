import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { constants, devNull, tmpdir } from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { recordOf, type JsonRecord } from './smoke-agent.js'

// The CLI and the daemon of a smoke, run from source
const CLI_DIRECTORY = path.join(import.meta.dirname, '..', 'apps', 'bytebureau')
const FROM_SOURCE = ['run', 'src/main.ts'] as const
// Where every throwaway home and repository is made, its links resolved as theirs are
const TEMP_ROOT = realpathSync(tmpdir())

// A daemon on a free port that keeps its secrets in a file under the home, never in the keychain
const HOME_CONFIG = { server: { port: 0 }, secrets: { backend: 'file' } }

// What a command left undone, once a signal stops the smoke, exits with
const NOT_RUN = 130

export interface Throwaway {
  readonly home: string
  readonly repo: string
  // The environment of every command: the smoke's own, on the throwaway home
  readonly env: Readonly<Record<string, string | undefined>>
  // Set once a signal stops the smoke: no further command starts, the cleanup still runs
  readonly stopping: { received: boolean }
  // The commands running now, which a SIGTERM sent to the smoke is passed on to
  readonly running: Set<Pick<ChildProcess, 'kill'>>
}

export interface Ran {
  readonly code: number
  readonly records: readonly JsonRecord[]
}

export interface Running {
  readonly done: Promise<Ran>
}

type Watch = (record: JsonRecord) => void

function unwatched(): void {
  // Nothing to watch: the records are kept all the same
}

// The lines of the smoke itself go to stderr; its stdout is what the commands printed
export const tell = (line: string): void => {
  console.error(`smoke: ${line}`)
}

// A home the CLI may run on: a directory under the temporary one that is still there, as its .. and links resolve
// An unset BYTEBUREAU_HOME is ~/.bytebureau to the CLI, so it never is one
export const isThrowawayHome = (home: string | undefined, root: string = TEMP_ROOT): boolean =>
  home !== undefined &&
  path.isAbsolute(home) &&
  existsSync(home) &&
  realpathSync(path.resolve(home)).startsWith(`${root}${path.sep}`)

// The environment of a command of the CLI, which runs on the smoke's own throwaway home or not at all
const cliEnv = (smoke: Throwaway, args: readonly string[]): Throwaway['env'] => {
  const home = smoke.env['BYTEBUREAU_HOME']
  if (home !== smoke.home || !isThrowawayHome(home)) {
    const where = home === undefined || home === '' ? 'an unset home, ~/.bytebureau' : home
    throw new Error(`refusing to run bytebureau ${args.join(' ')} on ${where}`)
  }
  return smoke.env
}

// Links resolved, as git reports paths: on macOS /var is a link to /private/var
const tempDir = (prefix: string): string => {
  const created = mkdtempSync(path.join(tmpdir(), prefix))
  return realpathSync(created)
}

export const throwaway = (): Throwaway => {
  const home = tempDir('bb-smoke-home-')
  return {
    home,
    repo: tempDir('bb-smoke-repo-'),
    env: { ...process.env, BYTEBUREAU_HOME: home },
    stopping: { received: false },
    running: new Set(),
  }
}

// The home's configuration, and a repository with one empty commit on main; the commit reads no git configuration of the person
export function prepare({ home, repo }: Throwaway): void {
  writeFileSync(path.join(home, 'config.json'), `${JSON.stringify(HOME_CONFIG)}\n`)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: readonly string[]): void => {
    execFileSync('git', ['-C', repo, ...args], { env, stdio: 'ignore' })
  }
  git('init', '-q', '-b', 'main')
  const author = ['-c', 'user.name=ByteBureau smoke', '-c', 'user.email=smoke@example.com']
  git(...author, 'commit', '-q', '--allow-empty', '-m', 'init')
}

// The lines of an output as they come; the last one may end without a newline
function eachLine(stdout: Readable, take: (line: string) => void): void {
  let rest = ''
  stdout.setEncoding('utf8')
  stdout.on('data', (chunk: string) => {
    const lines = `${rest}${chunk}`.split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) {
      take(line)
    }
  })
  stdout.once('end', () => {
    take(rest)
  })
}

// A line goes to stdout as the command printed it; a JSON one is kept and watched
const keeper =
  (records: JsonRecord[], watch: Watch) =>
  (line: string): void => {
    if (line.trim() === '') {
      return
    }
    console.log(line)
    const record = recordOf(line)
    if (record !== undefined) {
      records.push(record)
      watch(record)
    }
  }

// A command a signal ended exits as a shell tells it: 128 and the number of the signal
const exitOfSignal = (signal: NodeJS.Signals | null): number =>
  signal === null ? -1 : 128 + constants.signals[signal]

async function endOf(smoke: Throwaway, child: ChildProcess, records: JsonRecord[]): Promise<Ran> {
  smoke.running.add(child)
  const { promise, resolve, reject } = Promise.withResolvers<Ran>()
  child.once('error', reject)
  child.once('close', (code, signal) => {
    smoke.running.delete(child)
    resolve({ code: code ?? exitOfSignal(signal), records })
  })
  const ran = await promise
  return ran
}

// A command of the CLI on the throwaway home, whatever the signals: stdin closed, its stderr the smoke's
function spawned(smoke: Throwaway, args: readonly string[], watch: Watch): Running {
  const child = spawn('bun', [...FROM_SOURCE, ...args], {
    cwd: CLI_DIRECTORY,
    env: cliEnv(smoke, args),
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const records: JsonRecord[] = []
  eachLine(child.stdout, keeper(records, watch))
  return { done: endOf(smoke, child, records) }
}

// A command of the CLI on the throwaway home, unless a signal has stopped the smoke
export function started(
  smoke: Throwaway,
  args: readonly string[],
  watch: Watch = unwatched,
): Running {
  if (smoke.stopping.received) {
    return { done: Promise.resolve({ code: NOT_RUN, records: [] }) }
  }
  return spawned(smoke, args, watch)
}

// A command a person answers at the terminal: its stdin is the smoke's, its output goes to the smoke's stderr
export async function atTheTerminal(smoke: Throwaway, args: readonly string[]): Promise<number> {
  if (smoke.stopping.received) {
    return NOT_RUN
  }
  const child = spawn('bun', [...FROM_SOURCE, ...args], {
    cwd: CLI_DIRECTORY,
    env: cliEnv(smoke, args),
    stdio: ['inherit', 2, 'inherit'],
  })
  const ran = await endOf(smoke, child, [])
  return ran.code
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const killed = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Gone already
  }
}

// The daemon's pid, which the lock of its home holds while it runs
const daemonOf = (home: string): number | undefined => {
  try {
    const pid = Number(readFileSync(path.join(home, 'daemon.lock'), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

// A daemon that outlives its stop gets until the deadline, then SIGKILL; true when it ended by itself
async function endedBy(pid: number, deadline: number): Promise<boolean> {
  if (!alive(pid)) {
    return true
  }
  if (Date.now() >= deadline) {
    killed(pid)
    return false
  }
  await sleep(100)
  const ended = await endedBy(pid, deadline)
  return ended
}

// A step of the cleanup that fails is told, never thrown, so the failure that ended the smoke stays the one it ends with
async function attempted(what: string, step: () => Promise<void> | void): Promise<void> {
  try {
    await step()
  } catch (error) {
    tell(`${what} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// The daemon ends with the smoke, as serve --stop ends it, else by its pid; the home and the repository go whatever happened
export async function cleanedUp(smoke: Throwaway): Promise<void> {
  const pid = daemonOf(smoke.home)
  await attempted('serve --stop', async () => {
    const stop = await spawned(smoke, ['serve', '--stop', '--json'], unwatched).done
    tell(`serve --stop exited ${stop.code}`)
  })
  const ended = pid === undefined || (await endedBy(pid, Date.now() + 5000))
  await attempted('removing the home and the repository', () => {
    rmSync(smoke.home, { recursive: true, force: true })
    rmSync(smoke.repo, { recursive: true, force: true })
  })
  tell(
    `${ended ? '' : 'the daemon did not end and was killed; '}the home and the repository are gone`,
  )
}

const HELD = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

// A signal stops the smoke where it is: no further command starts, and the cleanup runs
// Ctrl-C and a hangup reach the commands of the terminal by themselves; a SIGTERM sent to the smoke alone is passed on to them
export const stopperOf =
  (smoke: Pick<Throwaway, 'stopping' | 'running'>) =>
  (signal: NodeJS.Signals): void => {
    if (!smoke.stopping.received) {
      tell(`${signal}: no further command starts; the daemon is stopped and the home removed`)
    }
    smoke.stopping.received = true
    if (signal === 'SIGTERM') {
      for (const child of smoke.running) {
        child.kill('SIGTERM')
      }
    }
  }

// The signals are held while the smoke runs; an abort of its caller stops it as a SIGTERM does, so a bounded caller leaves nothing
export function heldSignals(smoke: Throwaway, abort?: AbortSignal): () => void {
  const stop = stopperOf(smoke)
  const aborted = (): void => {
    stop('SIGTERM')
  }
  for (const signal of HELD) {
    process.on(signal, stop)
  }
  if (abort !== undefined) {
    abort.addEventListener('abort', aborted, { once: true })
  }
  if (abort !== undefined && abort.aborted) {
    aborted()
  }
  return () => {
    for (const signal of HELD) {
      process.off(signal, stop)
    }
    if (abort !== undefined) {
      abort.removeEventListener('abort', aborted)
    }
  }
}
