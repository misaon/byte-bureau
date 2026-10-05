import { Data } from 'effect'

const fieldOf = (error: unknown, key: string): unknown =>
  typeof error === 'object' && error !== null ? Reflect.get(error, key) : undefined

// The message of a typed error is its reason
function reasonMessage(this: unknown): string {
  const reason = fieldOf(this, 'reason')
  return typeof reason === 'string' ? reason : ''
}

// A store failure has no reason of its own; the message is what its cause says
function causeMessage(this: unknown): string {
  const cause = fieldOf(this, 'cause')
  return cause instanceof Error ? cause.message : String(cause)
}

// Effect builds a tagged error with an empty message; the getter on its prototype gives it one, so every printer of an Error says why
function described<Constructor extends object>(
  constructor: Constructor,
  message: (this: unknown) => string,
): Constructor {
  const prototype: unknown = Reflect.get(constructor, 'prototype')
  if (typeof prototype === 'object' && prototype !== null) {
    Reflect.defineProperty(prototype, 'message', { get: message, configurable: true })
  }
  return constructor
}

export const ConfigError = described(
  Data.TaggedError('ConfigError')<{
    readonly file: string
    readonly pointer: string
    readonly reason: string
  }>,
  reasonMessage,
)
export type ConfigError = InstanceType<typeof ConfigError>

// A configuration that cannot be used, in one line: where, then why; a reason that names the place already is not prefixed again
export const configErrorLine = ({ file, pointer, reason }: ConfigError): string => {
  const where = `${file}${pointer}`
  return reason.startsWith(`${where}: `) ? reason : `${where}: ${reason}`
}

export const StoreError = described(
  Data.TaggedError('StoreError')<{ readonly cause: unknown }>,
  causeMessage,
)
export type StoreError = InstanceType<typeof StoreError>

// Wraps a failure of the store layer, for Effect.mapError
export const toStoreError = (cause: unknown): StoreError => new StoreError({ cause })

export const WorkspaceError = described(
  Data.TaggedError('WorkspaceError')<{
    readonly code: string
    readonly reason: string
  }>,
  reasonMessage,
)
export type WorkspaceError = InstanceType<typeof WorkspaceError>

export const ProviderError = described(
  Data.TaggedError('ProviderError')<{
    readonly kind: 'auth' | 'ratelimit' | 'crash' | 'protocol' | 'missing'
    readonly reason: string
    readonly retryable: boolean
  }>,
  reasonMessage,
)
export type ProviderError = InstanceType<typeof ProviderError>

export const AskError = described(
  Data.TaggedError('AskError')<{
    readonly code: 'not_found' | 'not_pending' | 'invalid_answer'
    readonly reason: string
  }>,
  reasonMessage,
)
export type AskError = InstanceType<typeof AskError>

export const ProfileError = described(
  Data.TaggedError('ProfileError')<{
    readonly code: 'not_found' | 'exists' | 'invalid' | 'in_use'
    readonly reason: string
  }>,
  reasonMessage,
)
export type ProfileError = InstanceType<typeof ProfileError>

export const PluginError = described(
  Data.TaggedError('PluginError')<{
    readonly plugin: string
    readonly reason: string
  }>,
  reasonMessage,
)
export type PluginError = InstanceType<typeof PluginError>

export const SessionError = described(
  Data.TaggedError('SessionError')<{
    readonly code:
      | 'not_found'
      | 'invalid_transition'
      | 'provider_missing'
      | 'yolo_refused'
      | 'employee_missing'
    readonly reason: string
  }>,
  reasonMessage,
)
export type SessionError = InstanceType<typeof SessionError>
