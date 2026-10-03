import { readFileSync } from 'node:fs'
import type {
  Logger,
  LogLevel,
  PluginContext,
  PluginRegistration,
  ProcessSpawner,
  WorkspaceRuntime,
  WorkspaceSpec,
} from '@bytebureau/plugin-api'
import { LocalWorkspaceRuntime } from '../local-runtime.js'
import { nodeSpawner } from './node-spawner.js'

export const SESSION_ID = '0192f0c8-7b2e-7c3d-9a4b-000000000001'

export interface LogEntry {
  readonly level: LogLevel
  readonly message: string
}

// A logger that keeps what it is told, for the tests that look at warnings
export function recordingLogger(): { readonly logger: Logger; readonly entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const at =
    (level: LogLevel): Logger['debug'] =>
    (message) => {
      entries.push({ level, message })
    }
  const logger: Logger = {
    category: ['test'],
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  }
  return { logger, entries }
}

export function workspaceSpec(
  projectPath: string,
  overrides: Partial<WorkspaceSpec> = {},
): WorkspaceSpec {
  return {
    sessionId: SESSION_ID,
    projectPath,
    baseBranch: 'main',
    branch: 'bb/add-hello',
    copyIgnored: ['.env'],
    logger: recordingLogger().logger,
    ...overrides,
  }
}

export function createRuntime(
  spawner: ProcessSpawner = nodeSpawner,
  logger: Logger = recordingLogger().logger,
): LocalWorkspaceRuntime {
  return new LocalWorkspaceRuntime(spawner, logger)
}

export interface SpawnCall {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

// Records the arguments and the environment of every spawn, then runs the process for real
export function spySpawner(): { readonly spawner: ProcessSpawner; readonly calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawner: ProcessSpawner = {
    async spawn(spec) {
      calls.push({ args: [...spec.args], env: { ...spec.env } })
      const child = await nodeSpawner.spawn(spec)
      return child
    },
  }
  return { spawner, calls }
}

// A spawner that runs a Node script, chosen by the arguments, in place of every command
export function scriptedSpawner(scriptFor: (args: readonly string[]) => string): ProcessSpawner {
  return {
    async spawn(spec) {
      const args = ['-e', scriptFor(spec.args)]
      const child = await nodeSpawner.spawn({ ...spec, command: process.execPath, args })
      return child
    },
  }
}

// A spawner that fails the git commands that start with one of the phrases, such as 'branch -D', and runs the rest for real
export function failingSpawner(...phrases: readonly string[]): ProcessSpawner {
  return {
    async spawn(spec) {
      const fails = phrases.includes(spec.args.slice(0, 2).join(' '))
      const failure = { ...spec, command: process.execPath, args: ['-e', 'process.exit(1)'] }
      const child = await nodeSpawner.spawn(fails ? failure : spec)
      return child
    },
  }
}

// A spawner whose git reports one version and fails every other command
export function versionSpawner(version: string): ProcessSpawner {
  return scriptedSpawner((args) =>
    args[0] === '--version' ? `console.log('git version ${version}')` : 'process.exit(128)',
  )
}

const unused = (): never => {
  throw new Error('a workspace runtime does not use this part of the plugin context')
}

// Only the process spawner and the logger are real; the rest fails loudly when somebody reaches for it
export function pluginContext(spawner: ProcessSpawner): PluginContext {
  return {
    config: undefined,
    project: null,
    logger: recordingLogger().logger,
    events: { publish: unused, subscribe: unused },
    secrets: { get: unused, set: unused, delete: unused },
    kv: { get: unused, set: unused, delete: unused },
    process: spawner,
    http: fetch,
    signal: new AbortController().signal,
  }
}

export function soleRuntime(registration: PluginRegistration): WorkspaceRuntime {
  const [runtime, ...others] = registration.workspaceRuntimes ?? []
  if (runtime === undefined || others.length > 0) {
    throw new Error('expected the plugin to register exactly one workspace runtime')
  }
  return runtime
}

// Every line a stream yields
export async function readLines(stream: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = []
  for await (const line of stream) {
    lines.push(line)
  }
  return lines
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'))
}
