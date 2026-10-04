import { Context, type Duration, type Redacted } from 'effect'

export interface MutationLimitOptions {
  // Calls a client may make at once, and how many tokens a minute flow back
  readonly capacity: number
  readonly perMinute: number
}

export interface ApiOptions {
  readonly version: string
  readonly startedAt: string
  readonly token: Redacted.Redacted
  // Origins browsers may call the API from; empty means none (the embedded UI of SP2 is same-origin)
  readonly corsOrigins: readonly string[]
  readonly heartbeat: Duration.Input
  readonly mutationLimit: MutationLimitOptions
}

export class ApiConfig extends Context.Service<ApiConfig, ApiOptions>()('bb/api/ApiConfig') {}

export const DEFAULT_API_OPTIONS: Omit<ApiOptions, 'version' | 'startedAt' | 'token'> = {
  corsOrigins: [],
  heartbeat: '15 seconds',
  mutationLimit: { capacity: 60, perMinute: 60 },
}
