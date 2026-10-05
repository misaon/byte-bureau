import type {
  AgentCapabilities,
  AgentProvider,
  AgentSession,
  AuthStatus,
  CreateSessionRequest,
  ProfileRef,
} from '@bytebureau/plugin-api'
import { authStatusOf } from './auth.js'
import { claudeConfigOf } from './config.js'
import type { ClaudeDeps } from './deps.js'
import { resolveExecutable } from './executable.js'
import { ClaudeSession } from './session.js'

const CAPABILITIES: AgentCapabilities = {
  resume: true,
  interrupt: true,
  askUser: true,
  permissions: true,
  structuredOutput: false,
  usage: true,
  rateLimits: true,
  contextUsage: true,
  thinking: true,
  setModel: true,
  setEffort: false,
  attachments: false,
}

export class ClaudeAgentProvider implements AgentProvider {
  public readonly id = 'claude'
  public readonly displayName = 'Claude Code (Agent SDK)'
  public readonly capabilities = CAPABILITIES
  public readonly apiKeyEnv = 'ANTHROPIC_API_KEY'
  private readonly deps: ClaudeDeps

  public constructor(deps: ClaudeDeps) {
    this.deps = deps
  }

  public async authStatus(profile: ProfileRef): Promise<AuthStatus> {
    const status = await authStatusOf(this.deps, profile, this.executableOf({}))
    return status
  }

  public async createSession(request: CreateSessionRequest): Promise<AgentSession> {
    await Promise.resolve()
    return new ClaudeSession(this.deps, request, this.executableOf(request.providerConfig))
  }

  // The user's claude where it is configured or installed; the SDK's bundled binary when none is found
  private executableOf(providerConfig: Readonly<Record<string, unknown>>): string | undefined {
    const resolve = this.deps.resolveExecutable ?? resolveExecutable
    return resolve(claudeConfigOf(providerConfig).executable ?? 'claude')
  }
}
