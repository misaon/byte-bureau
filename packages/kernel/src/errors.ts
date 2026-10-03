import { Data } from 'effect'

export const ConfigError = Data.TaggedError('ConfigError')<{
  readonly file: string
  readonly pointer: string
  readonly reason: string
}>
export type ConfigError = InstanceType<typeof ConfigError>

export const StoreError = Data.TaggedError('StoreError')<{ readonly cause: unknown }>
export type StoreError = InstanceType<typeof StoreError>

export const WorkspaceError = Data.TaggedError('WorkspaceError')<{
  readonly code: string
  readonly reason: string
}>
export type WorkspaceError = InstanceType<typeof WorkspaceError>

export const ProviderError = Data.TaggedError('ProviderError')<{
  readonly kind: 'auth' | 'ratelimit' | 'crash' | 'protocol' | 'missing'
  readonly reason: string
  readonly retryable: boolean
}>
export type ProviderError = InstanceType<typeof ProviderError>

export const AskError = Data.TaggedError('AskError')<{
  readonly code: 'not_found' | 'not_pending' | 'invalid_answer'
  readonly reason: string
}>
export type AskError = InstanceType<typeof AskError>

export const PluginError = Data.TaggedError('PluginError')<{
  readonly plugin: string
  readonly reason: string
}>
export type PluginError = InstanceType<typeof PluginError>

export const SessionError = Data.TaggedError('SessionError')<{
  readonly code:
    | 'not_found'
    | 'invalid_transition'
    | 'provider_missing'
    | 'yolo_refused'
    | 'employee_missing'
  readonly reason: string
}>
export type SessionError = InstanceType<typeof SessionError>
