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
import { endProcess, sweepGroup } from './kill-ladder.js'
import type { Preset } from './presets.js'
import { endingOf, spawnAgent, type AcpDeps, type AgentProcess } from './process.js'
import { redacted } from './redaction.js'
import { RefusedAgentError } from './refused-agent-error.js'
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

// What a start may take when the kernel does not bound it, as for an agent started again for a prompt
const START_LIMIT_MS = 60_000
const AUTH_REQUIRED = -32_000
const EXIT_WAIT_MS = 2000
// A variable named as a key or a token is the agent's to hold, never a terminal's
const SECRET_NAME = /_(?:API_KEY|TOKEN)$/iu

// The values a session never repeats: the key of an API-key profile, under either variable it can travel in
const secretsOf = ({ request, preset, keyEnv }: Setup): readonly string[] =>
  [keyEnv, preset.apiKeyEnv].flatMap((name) => {
    const value = name === undefined ? undefined : request.env[name]
    return value === undefined || value === '' ? [] : [value]
  })

// The environment of the agent's terminals: the session's without the key of the profile or anything named as a key or a token
export const terminalEnvOf = ({
  request,
  preset,
  keyEnv,
}: Setup): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(request.env).filter(
      ([name]) => name !== keyEnv && name !== preset.apiKeyEnv && !SECRET_NAME.test(name),
    ),
  )

// What an error the agent answered says, with no secret of the session in it, and the login to perform when it asked for one
export const toldReason = (error: unknown, setup: Setup): string => {
  const reason = redacted(reasonOf(error), secretsOf(setup))
  const login = error instanceof RequestError && error.code === AUTH_REQUIRED
  return login ? `${reason}; log in with: ${setup.preset.loginHint}` : reason
}

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

// Why an agent could not start a session: what it answered, with the login to perform when it asked for one, or why the adapter refused it
// Any other failure is its death, a write to it failing or its connection closing, when it ends within two seconds; it is ended either way
const failureOf = async (agent: AgentProcess, error: unknown, setup: Setup): Promise<Error> => {
  const answered = error instanceof RequestError || error instanceof RefusedAgentError
  const exit = answered ? null : await withinLimit(agent.exited, EXIT_WAIT_MS)
  await endProcess(agent.child, agent.exited)
  if (exit !== null) {
    return new Error(endingOf(agent, exit))
  }
  return new Error(toldReason(error, setup))
}

// The agent connected and in an ACP session
// The updates a loaded session replays are let through before the agent is the session's, so none of them is told
const sessionOf = async (
  agent: AgentProcess,
  handlers: ClientHandlers,
  opening: {
    readonly cwd: string
    readonly resume: string | undefined
    readonly secrets: readonly string[]
  },
): Promise<Running> => {
  const connected = await connectAgent(agent, handlers)
  const { sessionId, notLoaded } = await openSession(connected, opening.cwd, opening.resume)
  await settled()
  const why = notLoaded === undefined ? {} : { notLoaded: redacted(notLoaded, opening.secrets) }
  return { process: agent, connection: connected.connection, sessionId, gone: false, ...why }
}

// The agent killed with its whole group: a wrapper's agent that holds the pipes would otherwise keep a start waiting
const killAll = (agent: AgentProcess): void => {
  sweepGroup(agent.child)
  agent.child.kill('SIGKILL')
}

// The work of a start, which its caller may give up on: the agent is killed then, so nothing waits on it
const whileStarting = async <Value>(
  signal: AbortSignal,
  agent: AgentProcess,
  work: Promise<Value>,
): Promise<Value> => {
  const abandon = (): void => {
    killAll(agent)
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

const limitText = (limitMs: number): string =>
  limitMs % 1000 === 0 ? `${limitMs / 1000} s` : `${limitMs} ms`

// A start within its time; one that is not done by then is killed with its group and refused as too slow
const inTime = async (
  agent: AgentProcess,
  started: Promise<Running>,
  limitMs: number,
): Promise<Running> => {
  const running = await withinLimit(started, limitMs)
  if (running === null) {
    killAll(agent)
    throw new RefusedAgentError(`the agent did not start a session within ${limitText(limitMs)}`)
  }
  return running
}

// How a start goes: the session to resume, the signal that gives it up, and the time it has when the kernel does not bound it
interface Starting {
  readonly resume?: string | undefined
  readonly signal: AbortSignal
  readonly limitMs?: number | undefined
}

// What a session asks of a start; the signal is its own
export type Launching = Omit<Starting, 'signal'>

// An agent started again for a session gets the start limit, and the session the one before had, to load
export const relaunchOf = (setup: Setup, ref: string | undefined): Launching => ({
  limitMs: setup.deps.startLimitMs ?? START_LIMIT_MS,
  resume: ref,
})

// An agent of the preset in an ACP session: loaded when the session to resume is known, else new; one that fails is ended, and says why
export const startAgent = async (
  setup: Setup,
  handlers: ClientHandlers,
  { resume, signal, limitMs }: Starting,
): Promise<Running> => {
  const cwd = setup.request.workspace.path
  const secrets = secretsOf(setup)
  const agent = await spawnAgent(setup.deps.spawn, setup.preset, {
    cwd,
    env: envOf(setup),
    secrets,
  })
  try {
    const started = sessionOf(agent, handlers, { cwd, resume, secrets })
    const timed = limitMs === undefined ? started : inTime(agent, started, limitMs)
    const running = await whileStarting(signal, agent, timed)
    return running
  } catch (error) {
    throw await failureOf(agent, error, setup)
  }
}
