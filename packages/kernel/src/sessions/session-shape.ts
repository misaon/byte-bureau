import type { PromptInput } from '@bytebureau/protocol'
import type { Effect } from 'effect'
import type {
  ConfigError,
  ProviderError,
  SessionError,
  StoreError,
  WorkspaceError,
} from '../errors.js'
import type { CreateSessionInput, Session, Turn } from './types.js'

export interface SessionManagerShape {
  readonly create: (
    input: CreateSessionInput,
  ) => Effect.Effect<Session, SessionError | WorkspaceError | ConfigError | StoreError>
  readonly prompt: (
    sessionId: string,
    input: PromptInput,
  ) => Effect.Effect<Turn, SessionError | ProviderError | StoreError>
  readonly interrupt: (sessionId: string) => Effect.Effect<void, SessionError | StoreError>
  readonly stop: (sessionId: string) => Effect.Effect<void, SessionError | StoreError>
  readonly complete: (sessionId: string) => Effect.Effect<void, SessionError | StoreError>
  readonly resume: (
    sessionId: string,
  ) => Effect.Effect<Session, SessionError | StoreError | ConfigError>
  readonly list: () => Effect.Effect<readonly Session[], StoreError>
  // Stops the sessions at work that no kernel still running owns or has attached, and gives their ids; meant for the start of a process
  readonly recover: () => Effect.Effect<readonly string[], SessionError | StoreError>
  readonly get: (id: string) => Effect.Effect<Session | undefined, StoreError>
}
