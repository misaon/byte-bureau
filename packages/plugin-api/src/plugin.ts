import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Ask, AskAnswer, EventEnvelope, KernelEvent, PromptInput } from '@bytebureau/protocol'
import type { Logger } from './logger.js'
import type { AgentProvider, ExecHandle, ExecSpec, SecretStore, WorkspaceRuntime } from './ports.js'

export type PluginKind = 'in-process' | 'subprocess' | 'mcp' | 'acp' | 'wasm'
export type PluginCapability = 'fs:read' | 'fs:write' | 'net' | 'process' | 'secrets' | 'ui'
export type PortId = 'agentProviders' | 'workspaceRuntimes' | 'secretStores'

export interface PluginManifest {
  readonly name: string
  readonly version: string
  readonly displayName?: string | undefined
  readonly description?: string | undefined
  readonly hostApi: string
  readonly kind: PluginKind
  readonly entry?: string | undefined
  readonly capabilities?: readonly PluginCapability[] | undefined
  readonly config?: StandardSchemaV1 | undefined
  readonly secrets?:
    | Readonly<Record<string, { readonly title: string; readonly description?: string }>>
    | undefined
  readonly contributes?: Partial<Readonly<Record<PortId, readonly string[]>>> | undefined
}

export interface ProjectInfo {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly defaultBranch: string
}

export interface PluginEvents {
  publish(event: KernelEvent): Promise<void>
  /** Events published from the moment the subscription opens, as the log stores them, with seq, id and timestamp; history is not replayed. */
  subscribe(filter: {
    readonly types?: readonly string[]
    readonly sessionId?: string
  }): AsyncIterable<EventEnvelope>
}

export interface PluginKv {
  // The stored JSON value; a plugin decodes it with its own schema
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export interface ProcessSpawner {
  spawn(spec: ExecSpec & { readonly cwd: string }): Promise<ExecHandle>
}

export interface PluginContext<Config = unknown> {
  readonly config: Config
  readonly project: ProjectInfo | null
  readonly logger: Logger
  readonly events: PluginEvents
  readonly secrets: SecretStore
  readonly kv: PluginKv
  readonly process: ProcessSpawner
  readonly http: typeof fetch
  readonly signal: AbortSignal
}

export type Hook<Input, Result> = (
  input: Readonly<Input>,
  next: (input: Input) => Promise<Result>,
) => Promise<Result>

export interface SessionCreateInput {
  readonly projectId: string
  readonly employeeId: string
  readonly providerId: string
  readonly title: string
}
export interface AgentSpawnInput {
  readonly sessionId: string
  readonly providerId: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}
export type AgentSpawnResult = AgentSpawnInput | { readonly deny: string }
export interface AskOpenInput {
  readonly ask: Ask
}
export type AskOpenResult = { readonly ask: Ask } | { readonly answer: AskAnswer }
export interface PromptSendInput {
  readonly sessionId: string
  readonly input: PromptInput
}

export interface Hooks {
  /** Reserved: the kernel does not invoke it before Phase C. */
  readonly 'session.beforeCreate': Hook<SessionCreateInput, SessionCreateInput>
  /** Reserved: the kernel does not invoke it before Phase C. */
  readonly 'agent.beforeSpawn': Hook<AgentSpawnInput, AgentSpawnResult>
  /** Reserved: the kernel does not invoke it before Phase C. */
  readonly 'ask.beforeOpen': Hook<AskOpenInput, AskOpenResult>
  /** Invoked for every prompt before the agent receives it; what it returns is what the agent gets, while the turn records what the caller said. */
  readonly 'prompt.beforeSend': Hook<PromptSendInput, PromptSendInput>
  /** Reserved: the kernel does not invoke it before Phase C. */
  readonly 'event.beforePublish': Hook<KernelEvent, void>
}

export interface PluginRegistration {
  readonly agentProviders?: readonly AgentProvider[] | undefined
  readonly workspaceRuntimes?: readonly WorkspaceRuntime[] | undefined
  readonly secretStores?: readonly SecretStore[] | undefined
  readonly hooks?: Partial<Hooks> | undefined
  dispose?(): Promise<void>
}

export interface Plugin<Config = unknown> {
  readonly manifest: PluginManifest
  setup(context: PluginContext<Config>): Promise<PluginRegistration> | PluginRegistration
}

/** Returns the plugin object unchanged so the host can read its manifest. */
export function definePlugin<Config>(plugin: Plugin<Config>): Plugin<Config> {
  return plugin
}
