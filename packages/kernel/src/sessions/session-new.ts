import type { EmployeeSpec } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { StoreError } from '../errors.js'
import { nowIso, uuidv7 } from '../ids.js'
import { NAMELESS_PROFILE_ID } from '../profiles/profile-ids.js'
import type { ResolvedProfile } from '../profiles/profile-service.js'
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

// What a creation has checked: the project, the employee the session gets and the profile it runs under
export interface Checked {
  readonly project: Project
  readonly employee: EmployeeSpec
  readonly profile: ResolvedProfile
}

// The record keeps the profile the session runs under; the nameless login of a provider without profiles is none
const storedProfileOf = ({ ref }: ResolvedProfile): string | null =>
  ref.id === NAMELESS_PROFILE_ID ? null : ref.id

export const newSession = (
  { project, employee, profile }: Checked,
  input: CreateSessionInput,
): Session => ({
  id: uuidv7(),
  projectId: project.id,
  title: input.title,
  employee,
  providerId: employee.provider,
  profileId: storedProfileOf(profile),
  workspace: null,
  externalRef: null,
  status: 'created',
  createdAt: nowIso(),
  startedAt: null,
  endedAt: null,
})

// The session exists from here on: its row, with the environment given at creation and this kernel as its owner, and the announcement of it
export const register = (
  deps: SessionDeps,
  session: Session,
  env: Readonly<Record<string, string>>,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* registersSession() {
    yield* insertSession(deps.sql, session, { env, owner: deps.instance })
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
