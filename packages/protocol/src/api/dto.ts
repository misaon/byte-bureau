import { Schema } from 'effect'
import { RateLimit, Usage } from '../agent-event.js'
import { Id, ProfileKind, SessionStatus, Timestamp, TurnStatus } from '../common.js'
import { ProjectConfig } from '../config.js'
import { EmployeeSpec, PromptInput } from '../employee.js'

export const ProjectDto = Schema.Struct({
  id: Id,
  name: Schema.String,
  path: Schema.String,
  defaultBranch: Schema.String,
  config: ProjectConfig,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).annotate({ title: 'Project', identifier: 'Project' })

// The handle of a worktree as the kernel keeps it: the id is the session id
export const WorkspaceHandleDto = Schema.Struct({
  id: Schema.String,
  runtimeId: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
}).annotate({ title: 'WorkspaceHandle', identifier: 'WorkspaceHandle' })

export const ExternalRefDto = Schema.Struct({
  providerId: Schema.String,
  ref: Schema.String,
}).annotate({ title: 'ExternalSessionRef', identifier: 'ExternalSessionRef' })

export const SessionDto = Schema.Struct({
  id: Id,
  projectId: Id,
  title: Schema.String,
  employee: EmployeeSpec,
  providerId: Schema.String,
  profileId: Schema.NullOr(Schema.String),
  workspace: Schema.NullOr(WorkspaceHandleDto),
  externalRef: Schema.NullOr(ExternalRefDto),
  status: SessionStatus,
  createdAt: Timestamp,
  startedAt: Schema.NullOr(Timestamp),
  endedAt: Schema.NullOr(Timestamp),
}).annotate({ title: 'Session', identifier: 'Session' })

export const TurnDto = Schema.Struct({
  id: Id,
  sessionId: Id,
  index: Schema.Int,
  prompt: PromptInput,
  status: TurnStatus,
  stopReason: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(Usage),
  startedAt: Timestamp,
  endedAt: Schema.NullOr(Timestamp),
}).annotate({ title: 'Turn', identifier: 'Turn' })

export const WorkspaceInfoDto = Schema.Struct({
  sessionId: Id,
  projectId: Id,
  path: Schema.String,
  branch: Schema.String,
  baseRef: Schema.String,
  sessionStatus: SessionStatus,
  exists: Schema.Boolean,
}).annotate({ title: 'WorkspaceInfo', identifier: 'WorkspaceInfo' })

export const PruneReportDto = Schema.Struct({
  removed: Schema.Array(Schema.String),
  retained: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
}).annotate({ title: 'PruneReport', identifier: 'PruneReport' })

export const SessionUsageDto = Schema.Struct({
  turns: Schema.Int,
  inputTokens: Schema.Int,
  outputTokens: Schema.Int,
  costUsd: Schema.NullOr(Schema.Finite),
  contextPct: Schema.NullOr(Schema.Finite),
}).annotate({ title: 'SessionUsage', identifier: 'SessionUsage' })

export const PluginStatusDto = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  state: Schema.Literals(['loaded', 'failed']),
  reason: Schema.optionalKey(Schema.String),
  ports: Schema.Array(Schema.String),
}).annotate({ title: 'PluginStatus', identifier: 'PluginStatus' })

export const AuthState = Schema.Literals(['loggedIn', 'loggedOut', 'expired', 'unknown'])

export const ProfileDto = Schema.Struct({
  id: Schema.String,
  providerId: Schema.String,
  name: Schema.String,
  kind: ProfileKind,
  configDir: Schema.NullOr(Schema.String),
  isDefault: Schema.Boolean,
  createdAt: Timestamp,
}).annotate({ title: 'Profile', identifier: 'Profile' })

export const ProfileStatusDto = Schema.Struct({
  profileId: Schema.String,
  state: AuthState,
  hint: Schema.optionalKey(Schema.String),
  account: Schema.optionalKey(Schema.String),
  checkedAt: Timestamp,
}).annotate({ title: 'ProfileStatus', identifier: 'ProfileStatus' })

export const UsageSnapshotDto = Schema.Struct({
  profileId: Schema.String,
  rateLimit: RateLimit,
  observedAt: Schema.NullOr(Timestamp),
}).annotate({ title: 'UsageSnapshot', identifier: 'UsageSnapshot' })

export const ProviderDto = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  // Whether the provider takes an API-key profile: it declares the variable the key travels in
  supportsApiKey: Schema.Boolean,
}).annotate({ title: 'Provider', identifier: 'Provider' })

export const HealthDto = Schema.Struct({
  status: Schema.Literals(['ok', 'degraded']),
  version: Schema.String,
  startedAt: Timestamp,
  checks: Schema.Struct({
    store: Schema.Literals(['ok', 'failed']),
    plugins: Schema.Struct({ loaded: Schema.Int, failed: Schema.Int }),
  }),
}).annotate({ title: 'Health', identifier: 'Health' })

export type ProjectDto = typeof ProjectDto.Type
export type WorkspaceHandleDto = typeof WorkspaceHandleDto.Type
export type ExternalRefDto = typeof ExternalRefDto.Type
export type SessionDto = typeof SessionDto.Type
export type TurnDto = typeof TurnDto.Type
export type WorkspaceInfoDto = typeof WorkspaceInfoDto.Type
export type PruneReportDto = typeof PruneReportDto.Type
export type SessionUsageDto = typeof SessionUsageDto.Type
export type PluginStatusDto = typeof PluginStatusDto.Type
export type AuthState = typeof AuthState.Type
export type ProfileDto = typeof ProfileDto.Type
export type ProfileStatusDto = typeof ProfileStatusDto.Type
export type UsageSnapshotDto = typeof UsageSnapshotDto.Type
export type ProviderDto = typeof ProviderDto.Type
export type HealthDto = typeof HealthDto.Type
