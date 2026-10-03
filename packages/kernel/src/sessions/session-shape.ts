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
  readonly interrupt: (sessionId: string) => Effect.Effect<void, SessionError>
  readonly stop: (sessionId: string) => Effect.Effect<void, SessionError | StoreError>
  readonly complete: (sessionId: string) => Effect.Effect<void, SessionError | StoreError>
  readonly resume: (sessionId: string) => Effect.Effect<Session, SessionError | StoreError>
  readonly list: () => Effect.Effect<readonly Session[], StoreError>
  readonly get: (id: string) => Effect.Effect<Session | undefined, StoreError>
}
