import type { WorkspaceHandle } from '@bytebureau/plugin-api'
import type { EmployeeSpec, SessionStatus } from '@bytebureau/protocol'
import { Effect, type Cause } from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'
import type { StoreError, WorkspaceError } from '../errors.js'
import type { Project } from '../projects/project-registry.js'
import { WorkspaceManager } from '../workspace/workspace-manager.js'

// The employee a record of a previous process names, in the shape the store reads back
const EMPLOYEE: EmployeeSpec = {
  id: 'developer',
  name: 'Developer',
  provider: 'fake',
  model: 'any',
  effort: null,
  systemPrompt: '',
  tools: { allow: [], deny: [] },
  permissionMode: 'supervised',
  skills: [],
  appearance: {},
}

const NOW = '2026-10-04T00:00:00.000Z'

// The statuses in which a turn runs: a session left in one of them has a turn to interrupt
const WITH_TURN: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'running',
  'waiting_for_human',
  'paused_usage_limit',
])

export interface Left {
  readonly sessionId: string
  readonly turnId: string
}

// The process and the kernel a session row names as its owner
export interface SeededOwner {
  readonly pid: number | null
  readonly instance: string | null
}

// No owner, as a row from before owners were recorded
const NOBODY: SeededOwner = { pid: null, instance: null }

// A process that is gone: the largest pid kill accepts, above any a system hands out
export const GONE: SeededOwner = { pid: 2 ** 31 - 1, instance: 'gone' }

// A project row for such sessions to belong to; no repository stands behind it
export const seedProject = (
  projectId: string,
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* seedsProject() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO projects (id, name, path, default_branch, config_json, created_at, updated_at) VALUES (${projectId}, ${projectId}, ${`/${projectId}`}, 'main', '{}', ${NOW}, ${NOW})`
  })

// The id says which status of which project the session was left in
export const leftIdOf = (projectId: string, status: SessionStatus): string =>
  `${status}-of-${projectId}`

// A session, and its running turn when it has one, as a previous process left them: nothing of them is attached here
export const leftBehind = (
  projectId: string,
  status: SessionStatus,
  owner: SeededOwner = NOBODY,
): Effect.Effect<Left, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* seedsLeftBehind() {
    const sql = yield* SqlClient.SqlClient
    const sessionId = leftIdOf(projectId, status)
    const turnId = `turn-of-${sessionId}`
    yield* sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, profile_id, workspace_json, status, created_at, started_at, owner_pid, owner_instance) VALUES (${sessionId}, ${projectId}, 'left', ${JSON.stringify(EMPLOYEE)}, 'fake', NULL, '{}', ${status}, ${NOW}, ${NOW}, ${owner.pid}, ${owner.instance})`
    if (WITH_TURN.has(status)) {
      yield* sql`INSERT INTO turns (id, session_id, idx, prompt_json, status, started_at) VALUES (${turnId}, ${sessionId}, 0, '{"text":"go"}', 'running', ${NOW})`
    }
    return { sessionId, turnId }
  })

// A session at work whose row does not fit the protocol: its employee is no employee
export const seedUnreadable = (
  projectId: string,
): Effect.Effect<string, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* seedsUnreadable() {
    const sql = yield* SqlClient.SqlClient
    const sessionId = `unreadable-of-${projectId}`
    yield* sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, workspace_json, status, created_at) VALUES (${sessionId}, ${projectId}, 'unreadable', '{}', 'fake', '{}', 'running', ${NOW})`
    return sessionId
  })

// A pending ask of the session whose record does not fit, so cancelling the asks of the session fails
export const seedBrokenAsk = (
  left: Left,
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* seedsBrokenAsk() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO asks (id, session_id, turn_id, kind, payload_json, status, recommendation_source, created_at) VALUES (${`ask-of-${left.sessionId}`}, ${left.sessionId}, ${left.turnId}, 'question', 'not json', 'pending', 'agent', ${NOW})`
  })

// The row names another owner, as if that kernel had claimed the session last
export const nameOwner = (
  sessionId: string,
  owner: SeededOwner,
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* namesOwner() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE sessions SET owner_pid = ${owner.pid}, owner_instance = ${owner.instance} WHERE id = ${sessionId}`
  })

// The owner a session row names
export const ownerOf = (
  sessionId: string,
): Effect.Effect<SeededOwner, SqlError.SqlError | Cause.NoSuchElementError, SqlClient.SqlClient> =>
  Effect.gen(function* readsOwner() {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{
      readonly owner_pid: number | null
      readonly owner_instance: string | null
    }>`SELECT owner_pid, owner_instance FROM sessions WHERE id = ${sessionId}`
    const found = yield* Effect.fromNullishOr(row)
    return { pid: found.owner_pid, instance: found.owner_instance }
  })

export interface ProvisionedLeft {
  readonly left: Left
  readonly handle: WorkspaceHandle
}

// A session left behind whose worktree provisioning had made
export const provisionedLeft = (
  project: Project,
  status: SessionStatus,
  owner: SeededOwner = NOBODY,
): Effect.Effect<
  ProvisionedLeft,
  SqlError.SqlError | WorkspaceError | StoreError,
  SqlClient.SqlClient | WorkspaceManager
> =>
  Effect.gen(function* provisionsLeft() {
    const left = yield* leftBehind(project.id, status, owner)
    const manager = yield* WorkspaceManager
    const handle = yield* manager.provision({
      sessionId: left.sessionId,
      project,
      title: 'left',
      baseBranch: 'main',
      runtimeId: 'local',
    })
    return { left, handle }
  })
