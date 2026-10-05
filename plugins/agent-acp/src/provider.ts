import { accessSync, constants, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type {
  AgentCapabilities,
  AgentProvider,
  AgentSession,
  AuthStatus,
  CreateSessionRequest,
  ProfileRef,
} from '@bytebureau/plugin-api'
import { CUSTOM, presetOf } from './custom-preset.js'
import { loginHintOf } from './login-hint.js'
import { PRESETS, providerIdOf, type Preset, type PresetId } from './presets.js'
import type { AcpDeps } from './process.js'
import { AcpSession } from './session.js'

const CAPABILITIES: AgentCapabilities = {
  resume: true,
  interrupt: true,
  askUser: false,
  permissions: true,
  structuredOutput: false,
  usage: false,
  rateLimits: false,
  contextUsage: false,
  thinking: true,
  setModel: false,
  setEffort: false,
  attachments: false,
}

const WINDOWS_SUFFIXES = ['', '.exe', '.cmd']

const isExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}

// Whether the daemon finds a command as spawn does: a path as it is, a bare name on PATH; nothing is run to find out
const onPath = (command: string): boolean => {
  if (command.includes('/') || command.includes(path.sep)) {
    return isExecutable(command)
  }
  const suffixes = process.platform === 'win32' ? WINDOWS_SUFFIXES : ['']
  const directories = (process.env['PATH'] ?? '')
    .split(path.delimiter)
    .filter((entry) => entry !== '')
  return directories.some((directory) =>
    suffixes.some((suffix) => isExecutable(path.join(directory, `${command}${suffix}`))),
  )
}

const builtInOf = (preset: PresetId): Preset | undefined =>
  preset === 'custom' ? undefined : PRESETS[preset]

// ACP v1 has authenticate but no status query: an agent that is not installed says how to install it, a login profile whose directory is gone needs a login, anything else is unknown
// The custom command is known only from a project's configuration, which a status check does not have
const authStatusOf = (preset: PresetId, profile: ProfileRef): AuthStatus => {
  const builtIn = builtInOf(preset)
  if (builtIn !== undefined && !onPath(builtIn.command)) {
    return { state: 'unknown', hint: builtIn.installHint }
  }
  const hint = loginHintOf(builtIn ?? CUSTOM, profile)
  const { kind, configDir } = profile
  const gone = kind === 'login' && configDir !== undefined && !existsSync(configDir)
  return { state: gone ? 'loggedOut' : 'unknown', hint }
}

// The ACP agent of one preset as a provider: acp:codex, acp:gemini, acp:opencode, acp:pi or acp:custom
export class AcpAgentProvider implements AgentProvider {
  public readonly id: string
  public readonly displayName: string
  public readonly capabilities = CAPABILITIES
  // The custom provider takes no API-key profiles: the variable of its key is known only from a project's configuration
  public readonly apiKeyEnv: string | undefined
  private readonly preset: PresetId
  private readonly deps: AcpDeps

  public constructor(preset: PresetId, deps: AcpDeps) {
    const builtIn = builtInOf(preset)
    this.preset = preset
    this.deps = deps
    this.id = providerIdOf(preset)
    this.displayName = builtIn === undefined ? CUSTOM.displayName : builtIn.displayName
    this.apiKeyEnv = builtIn === undefined ? undefined : builtIn.apiKeyEnv
  }

  public async authStatus(profile: ProfileRef): Promise<AuthStatus> {
    await Promise.resolve()
    return authStatusOf(this.preset, profile)
  }

  // The hints a session tells, when its agent is missing or asks for a login, name the login of its profile
  public async createSession(request: CreateSessionRequest): Promise<AgentSession> {
    const configured = presetOf(this.preset, request.providerConfig, request.trust)
    const preset = { ...configured, loginHint: loginHintOf(configured, request.profile) }
    const setup = { request, preset, deps: this.deps, providerId: this.id, keyEnv: this.apiKeyEnv }
    const session = await AcpSession.start(setup)
    return session
  }
}
