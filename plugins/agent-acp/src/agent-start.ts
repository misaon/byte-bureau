import { RequestError } from '@agentclientprotocol/sdk'
import type { CreateSessionRequest } from '@bytebureau/plugin-api'
import {
  connectAgent,
  openSession,
  reasonOf,
  settled,
  type ClientHandlers,
  type Running,
} from './connection.js'
import { endProcess } from './kill-ladder.js'
import type { Preset } from './presets.js'
import { endingOf, spawnAgent, type AcpDeps, type AgentProcess } from './process.js'
import { redacted } from './redaction.js'
import { withinLimit } from './within-limit.js'

// What a session starts its agents from
export interface Setup {
  readonly request: CreateSessionRequest
  readonly preset: Preset
  readonly deps: AcpDeps
  readonly providerId: string
  // The variable the provider declares for the key of an API-key profile, the one the kernel hands the key in
  readonly keyEnv: string | undefined
}

const AUTH_REQUIRED = -32_000
const EXIT_WAIT_MS = 2000

// The values a session never repeats: the key of an API-key profile, under either variable it can travel in
export const secretsOf = ({ request, preset, keyEnv }: Setup): readonly string[] =>
  [keyEnv, preset.apiKeyEnv].flatMap((name) => {
    const value = name === undefined ? undefined : request.env[name]
    return value === undefined || value === '' ? [] : [value]
  })

// What an error the agent answered says, with no secret of the session in it
export const toldReason = (error: unknown, setup: Setup): string =>
  redacted(reasonOf(error), secretsOf(setup))

// A key the kernel handed under the variable the provider declares travels under the one the preset names, when that is another
const movedKey = (
  env: Readonly<Record<string, string>>,
  declared: string | undefined,
  wanted: string | undefined,
): Readonly<Record<string, string>> => {
  const key = declared === undefined ? undefined : env[declared]
  if (key === undefined || wanted === undefined || wanted === declared) {
    return env
  }
  const others = Object.entries(env).filter(([name]) => name !== declared)
  return { ...Object.fromEntries(others), [wanted]: key }
}

// The environment of the agent: the request's (the kernel's allowlist and the key of the profile) and the directory of a login profile; the preset's own is added at the spawn
const envOf = ({ request, preset, keyEnv }: Setup): Readonly<Record<string, string>> => {
  const env = movedKey(request.env, keyEnv, preset.apiKeyEnv)
  const { kind, configDir } = request.profile
  const { configDirEnv } = preset
  return kind === 'login' && configDir !== undefined && configDirEnv !== undefined
    ? { ...env, [configDirEnv]: configDir }
    : env
}

// Why an agent could not start a session: what it answered, with the login to perform when it asked for one
// Any other failure is its death, a write to it failing or its connection closing, when it ends within two seconds; it is ended either way
const failureOf = async (agent: AgentProcess, error: unknown, setup: Setup): Promise<Error> => {
  const answered = error instanceof RequestError
  const exit = answered ? null : await withinLimit(agent.exited, EXIT_WAIT_MS)
  await endProcess(agent.child, agent.exited)
  if (exit !== null) {
    return new Error(endingOf(agent, exit))
  }
  const reason = toldReason(error, setup)
  const login = answered && error.code === AUTH_REQUIRED
  return new Error(login ? `${reason}; log in with: ${setup.preset.loginHint}` : reason)
}

// The agent connected and in an ACP session
// The updates a loaded session replays are let through before the agent is the session's, so none of them is told
const sessionOf = async (
  agent: AgentProcess,
  handlers: ClientHandlers,
  { cwd, resume }: { readonly cwd: string; readonly resume: string | undefined },
): Promise<Running> => {
  const connected = await connectAgent(agent, handlers)
  const sessionId = await openSession(connected, cwd, resume)
  await settled()
  return { process: agent, connection: connected.connection, sessionId, gone: false }
}

// The work of a start, which the kernel may give up on: the agent is killed then, so nothing waits on it
const whileStarting = async <Value>(
  signal: AbortSignal,
  agent: AgentProcess,
  work: Promise<Value>,
): Promise<Value> => {
  const abandon = (): void => {
    agent.child.kill('SIGKILL')
  }
  signal.addEventListener('abort', abandon, { once: true })
  if (signal.aborted) {
    abandon()
  }
  try {
    const value = await work
    return value
  } finally {
    signal.removeEventListener('abort', abandon)
  }
}

// An agent of the preset in an ACP session: loaded when the session to resume is known, else new; one that fails is ended, and says why
export const startAgent = async (
  setup: Setup,
  handlers: ClientHandlers,
  resume: string | undefined,
): Promise<Running> => {
  const cwd = setup.request.workspace.path
  const options = { cwd, env: envOf(setup), secrets: secretsOf(setup) }
  const agent = await spawnAgent(setup.deps.spawn, setup.preset, options)
  try {
    const started = sessionOf(agent, handlers, { cwd, resume })
    const running = await whileStarting(setup.request.signal, agent, started)
    return running
  } catch (error) {
    throw await failureOf(agent, error, setup)
  }
}
