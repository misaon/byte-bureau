import type {
  AddProfileBody,
  AskAnswer,
  AskRecord,
  CreateSessionBody,
  EventEnvelope,
  EventsFilter,
  HealthDto,
  PluginStatusDto,
  ProfileDto,
  ProfileStatusDto,
  ProjectDto,
  PromptInput,
  ProviderDto,
  PruneReportDto,
  SessionDto,
  SessionUsageDto,
  TurnDto,
  UsageSnapshotDto,
  WorkspaceInfoDto,
} from '@bytebureau/protocol'

// What a command asks of ByteBureau; the daemon answers it over the API, the in-process kernel directly
export interface Bureau {
  readonly projects: {
    readonly register: (path: string) => Promise<ProjectDto>
    readonly list: () => Promise<readonly ProjectDto[]>
    readonly get: (id: string) => Promise<ProjectDto | undefined>
    readonly remove: (id: string) => Promise<void>
  }
  readonly sessions: {
    readonly create: (body: CreateSessionBody) => Promise<SessionDto>
    readonly prompt: (sessionId: string, input: PromptInput) => Promise<TurnDto>
    readonly interrupt: (sessionId: string) => Promise<void>
    readonly stop: (sessionId: string) => Promise<void>
    readonly complete: (sessionId: string) => Promise<void>
    readonly resume: (sessionId: string) => Promise<SessionDto>
    readonly list: () => Promise<readonly SessionDto[]>
    readonly get: (id: string) => Promise<SessionDto | undefined>
  }
  readonly profiles: {
    readonly list: () => Promise<readonly ProfileDto[]>
    // The key of an API-key profile travels in the body, and nowhere else
    readonly add: (body: AddProfileBody) => Promise<ProfileDto>
    // Purge removes the login directory of the profile as well
    readonly remove: (id: string, options?: { readonly purge?: boolean }) => Promise<void>
    readonly setDefault: (id: string) => Promise<void>
    readonly status: (id: string) => Promise<ProfileStatusDto>
  }
  readonly asks: {
    readonly pending: (sessionId?: string) => Promise<readonly AskRecord[]>
    readonly get: (id: string) => Promise<AskRecord | undefined>
    readonly answer: (askId: string, answer: AskAnswer) => Promise<void>
  }
  readonly events: {
    // Durable events after since replayed, then live; ephemeral ones unless the filter says ephemeral: false
    readonly subscribe: (filter: EventsFilter, signal?: AbortSignal) => AsyncIterable<EventEnvelope>
  }
  readonly workspaces: {
    readonly list: (projectId?: string) => Promise<readonly WorkspaceInfoDto[]>
    readonly prune: (projectId?: string) => Promise<PruneReportDto>
  }
  readonly usage: {
    readonly session: (sessionId: string) => Promise<SessionUsageDto>
    readonly profile: (id: string) => Promise<UsageSnapshotDto>
  }
  readonly plugins: {
    readonly list: () => Promise<readonly PluginStatusDto[]>
    readonly providers: () => Promise<readonly ProviderDto[]>
  }
  readonly health: { readonly check: () => Promise<HealthDto> }
  // Where the commands talk to: the daemon's URL, or in-process
  readonly where:
    | { readonly kind: 'daemon'; readonly url: string }
    | { readonly kind: 'in-process' }
  readonly close: () => Promise<void>
}
