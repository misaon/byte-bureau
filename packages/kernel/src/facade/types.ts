import type { AnsweredVia, Ask, AskAnswer, EventEnvelope, PromptInput } from '@bytebureau/protocol'
import type { ConfigIssue, ResolvedConfig } from '../config/config.js'
import type { EventFilter } from '../events/event-log.js'
import type { HealthReport } from '../health/health.js'
import type { KernelLayerOptions } from '../kernel-live.js'
import type { PluginStatus } from '../plugins/plugin-host.js'
import type { Project } from '../projects/project-registry.js'
import type { CreateSessionInput, Session, Turn } from '../sessions/types.js'
import type { SessionUsage } from '../usage/usage-service.js'
import type { PruneReport, WorkspaceInfo } from '../workspace/workspace-manager.js'

// The log level of the layer comes from logging.level, a string as the command line gives it
export interface KernelOptions extends Omit<KernelLayerOptions, 'logLevel'> {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly logging?:
    | {
        readonly debug?: string | undefined
        readonly level?: string | undefined
        readonly json?: boolean | undefined
      }
    | undefined
}

export interface Kernel {
  readonly projects: {
    readonly register: (path: string) => Promise<Project>
    readonly list: () => Promise<readonly Project[]>
    readonly get: (id: string) => Promise<Project | undefined>
    readonly remove: (id: string) => Promise<void>
  }
  readonly config: {
    readonly load: (projectPath?: string) => Promise<ResolvedConfig>
    readonly validate: (projectPath: string) => Promise<readonly ConfigIssue[]>
    readonly schema: () => Record<string, unknown>
  }
  readonly sessions: {
    readonly create: (input: CreateSessionInput) => Promise<Session>
    readonly prompt: (sessionId: string, input: PromptInput) => Promise<Turn>
    readonly interrupt: (sessionId: string) => Promise<void>
    readonly stop: (sessionId: string) => Promise<void>
    readonly complete: (sessionId: string) => Promise<void>
    readonly resume: (sessionId: string) => Promise<Session>
    readonly list: () => Promise<readonly Session[]>
    readonly get: (id: string) => Promise<Session | undefined>
    /**
     * Stops the sessions left at work by kernels that are gone and resolves with their ids.
     * Meant for the start of a process: the kernel runs it once as it starts, and a session that a running kernel owns is left alone.
     */
    readonly recover: () => Promise<readonly string[]>
  }
  readonly asks: {
    readonly pending: (sessionId?: string) => Promise<readonly Ask[]>
    readonly answer: (askId: string, answer: AskAnswer, via: AnsweredVia) => Promise<void>
  }
  readonly events: {
    /**
     * Replays the durable events after filter.since, all of them when since is left out, and then follows them live.
     * Pass the last seq a consumer has seen as since to resume without a gap or a duplicate.
     */
    readonly subscribe: (filter: EventFilter) => AsyncIterable<EventEnvelope>
    readonly read: (
      filter: EventFilter,
      range: { readonly from: number; readonly to?: number },
    ) => Promise<readonly EventEnvelope[]>
  }
  readonly workspaces: {
    readonly list: (projectId?: string) => Promise<readonly WorkspaceInfo[]>
    readonly prune: (projectId?: string) => Promise<PruneReport>
  }
  readonly usage: { readonly session: (sessionId: string) => Promise<SessionUsage> }
  readonly providers: {
    readonly list: () => readonly { readonly id: string; readonly displayName: string }[]
  }
  readonly plugins: { readonly list: () => readonly PluginStatus[] }
  readonly health: { readonly check: () => Promise<HealthReport> }
  /** Stops the agents and ends the open event subscriptions; a call made after it may reject. */
  readonly close: () => Promise<void>
}
