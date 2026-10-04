import type { EmployeeSpec, SessionStatus } from '@bytebureau/protocol'
import { Effect } from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'

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

export interface Left {
  readonly sessionId: string
  readonly turnId: string
}

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

// A session and its running turn as a previous process left them: nothing of them is attached here
export const leftBehind = (
  projectId: string,
  status: SessionStatus,
): Effect.Effect<Left, SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* seedsLeftBehind() {
    const sql = yield* SqlClient.SqlClient
    const sessionId = leftIdOf(projectId, status)
    const turnId = `turn-of-${sessionId}`
    yield* sql`INSERT INTO sessions (id, project_id, title, employee_json, provider_id, profile_id, workspace_json, status, created_at, started_at) VALUES (${sessionId}, ${projectId}, 'left', ${JSON.stringify(EMPLOYEE)}, 'fake', NULL, '{}', ${status}, ${NOW}, ${NOW})`
    yield* sql`INSERT INTO turns (id, session_id, idx, prompt_json, status, started_at) VALUES (${turnId}, ${sessionId}, 0, '{"text":"go"}', 'running', ${NOW})`
    return { sessionId, turnId }
  })
