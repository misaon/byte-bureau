import type { EmployeeSpec } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { StoreError } from '../errors.js'
import { nowIso, uuidv7 } from '../ids.js'
import type { Project } from '../projects/project-registry.js'
import type { SessionDeps } from './session-deps.js'
import { insertSession } from './session-records.js'
import type { CreateSessionInput, Session } from './types.js'

// What is created: the project the session belongs to, the session itself and what the caller asked for
export interface Creation {
  readonly project: Project
  readonly session: Session
  readonly input: CreateSessionInput
}

export const newSession = (
  project: Project,
  employee: EmployeeSpec,
  input: CreateSessionInput,
): Session => ({
  id: uuidv7(),
  projectId: project.id,
  title: input.title,
  employee,
  providerId: employee.provider,
  profileId: input.profileId ?? null,
  workspace: null,
  externalRef: null,
  status: 'created',
  createdAt: nowIso(),
  startedAt: null,
  endedAt: null,
})

// The session exists from here on: its row, with the environment given at creation, and the announcement of it
export const register = (
  deps: SessionDeps,
  session: Session,
  env: Readonly<Record<string, string>>,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* registersSession() {
    yield* insertSession(deps.sql, session, env)
    yield* deps.log.publish({
      type: 'session.created',
      sessionId: session.id,
      projectId: session.projectId,
      payload: {
        status: 'created',
        title: session.title,
        employeeId: session.employee.id,
        providerId: session.providerId,
      },
    })
  })
