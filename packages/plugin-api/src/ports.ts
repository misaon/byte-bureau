import type { AgentEvent, AskAnswer, Effort, EmployeeSpec, PromptInput } from '@bytebureau/protocol'
import type { Logger } from './logger.js'

export interface ProfileRef {
  readonly id: string
  readonly providerId: string
  readonly kind: 'login' | 'api_key'
  readonly configDir?: string | undefined
}

export type AuthState = 'loggedIn' | 'loggedOut' | 'expired' | 'unknown'

export interface AuthStatus {
  readonly state: AuthState
  readonly hint?: string | undefined
  readonly account?: string | undefined
}

export interface ModelInfo {
  readonly id: string
  readonly displayName: string
  readonly contextWindow?: number | undefined
}

export interface AgentCapabilities {
  readonly resume: boolean
  readonly interrupt: boolean
  readonly askUser: boolean
  readonly permissions: boolean
  readonly structuredOutput: boolean
  readonly usage: boolean
  readonly rateLimits: boolean
  readonly contextUsage: boolean
  readonly thinking: boolean
  readonly setModel: boolean
  readonly setEffort: boolean
  readonly attachments: boolean
}

export interface ExternalSessionRef {
  readonly providerId: string
  readonly ref: string
}

export interface CreateSessionRequest {
  readonly sessionId: string
  readonly workspace: { readonly path: string }
  readonly employee: EmployeeSpec
  readonly profile: ProfileRef
  readonly resume?: ExternalSessionRef | undefined
  readonly env: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly logger: Logger
}

export interface AgentSession {
  readonly externalRef: ExternalSessionRef | null
  readonly prompt: (input: PromptInput) => Promise<void>
  readonly interrupt: () => Promise<void>
  readonly answer: (askId: string, answer: AskAnswer) => Promise<void>
  readonly setModel?: ((model: string) => Promise<void>) | undefined
  readonly setEffort?: ((effort: Effort) => Promise<void>) | undefined
  readonly events: () => AsyncIterable<AgentEvent>
  readonly close: () => Promise<void>
}

export interface AgentProvider {
  readonly id: string
  readonly displayName: string
  readonly capabilities: AgentCapabilities
  readonly authStatus: (profile: ProfileRef) => Promise<AuthStatus>
  readonly listModels?: ((profile: ProfileRef) => Promise<ModelInfo[]>) | undefined
  readonly createSession: (request: CreateSessionRequest) => Promise<AgentSession>
}

export type WorkspaceIsolation = 'none' | 'process' | 'container' | 'vm'

export interface WorkspaceSpec {
  readonly sessionId: string
  readonly projectPath: string
  readonly baseBranch: string
  readonly branch: string
  readonly copyIgnored: readonly string[]
  readonly logger: Logger
}

export interface WorkspaceHandle {
  readonly id: string
  readonly runtimeId: string
  readonly path: string
  readonly branch: string
  readonly baseRef: string
}

export interface WorkspaceStatus {
  readonly dirty: boolean
  readonly ahead: number
  readonly behind: number
  readonly locked: boolean
  readonly branch: string
}

export interface ExecSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

export interface ExecHandle {
  readonly pid: number
  readonly stdout: AsyncIterable<string>
  readonly stderr: AsyncIterable<string>
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>
  readonly kill: (signal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL') => void
}

export interface WorkspaceRuntime {
  readonly id: string
  readonly isolation: WorkspaceIsolation
  readonly provision: (spec: WorkspaceSpec) => Promise<WorkspaceHandle>
  readonly exec: (handle: WorkspaceHandle, spec: ExecSpec) => Promise<ExecHandle>
  readonly status: (handle: WorkspaceHandle) => Promise<WorkspaceStatus>
  readonly destroy: (
    handle: WorkspaceHandle,
    options?: { readonly force?: boolean },
  ) => Promise<void>
}

export interface SecretStore {
  readonly get: (key: string) => Promise<string | undefined>
  readonly set: (key: string, value: string) => Promise<void>
  readonly delete: (key: string) => Promise<void>
}
