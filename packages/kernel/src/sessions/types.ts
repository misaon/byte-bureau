import type { ExternalSessionRef, WorkspaceHandle } from '@bytebureau/plugin-api'
import type {
  EmployeeSpec,
  PromptInput,
  SessionStatus,
  TurnStatus,
  Usage,
} from '@bytebureau/protocol'

export interface Session {
  readonly id: string
  readonly projectId: string
  readonly title: string
  readonly employee: EmployeeSpec
  readonly providerId: string
  readonly profileId: string | null
  readonly workspace: WorkspaceHandle | null
  readonly externalRef: ExternalSessionRef | null
  readonly status: SessionStatus
  readonly createdAt: string
  readonly startedAt: string | null
  readonly endedAt: string | null
}

export interface Turn {
  readonly id: string
  readonly sessionId: string
  readonly index: number
  readonly prompt: PromptInput
  readonly status: TurnStatus
  readonly stopReason: string | null
  readonly usage: Usage | null
  readonly startedAt: string
  readonly endedAt: string | null
}

export interface CreateSessionInput {
  readonly projectId: string
  readonly title: string
  readonly employeeId?: string | undefined
  readonly providerId?: string | undefined
  readonly profileId?: string | undefined
  readonly branch?: string | undefined
  // Extra environment for the agent; only the BYTEBUREAU_* names are passed on, the rest is dropped
  readonly env?: Readonly<Record<string, string>> | undefined
}
