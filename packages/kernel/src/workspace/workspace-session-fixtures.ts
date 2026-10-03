import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkspaceHandle } from '@bytebureau/plugin-api'
import { Effect, type Cause } from 'effect'
import { SqlClient } from 'effect/sql'
import { toStoreError, WorkspaceError, type ConfigError, type StoreError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { ProjectRegistry, type Project } from '../projects/project-registry.js'
import { createTempRepo, git } from '../testing/temp-repo.js'
import { WorkspaceManager } from './workspace-manager.js'

export interface RegisteredRepo {
  readonly repo: string
  readonly project: Project
}

// A fixture repository registered as a project, its project file carrying the given workspace section
export const registerRepo = (
  workspace: Record<string, unknown> = {},
): Effect.Effect<RegisteredRepo, WorkspaceError | ConfigError | StoreError, ProjectRegistry> =>
  Effect.gen(function* registersRepo() {
    const repo = createTempRepo()
    const config = { version: 1, project: { name: 'fixture' }, workspace, employees: {} }
    writeFileSync(path.join(repo, 'bytebureau.json'), JSON.stringify(config))
    const registry = yield* ProjectRegistry
    return { repo, project: yield* registry.register(repo) }
  })

export interface SessionSeed {
  readonly id: string
  readonly status: string
  readonly endedAt?: string | undefined
  readonly workspace?: string | undefined
}

// A session row; without a workspace record it carries the empty one a new session starts with
export const seedSession = (
  projectId: string,
  seed: SessionSeed,
): Effect.Effect<void, StoreError, SqlClient.SqlClient> =>
  Effect.gen(function* seedsSession() {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO sessions (id, project_id, title, employee_json, provider_id, workspace_json, status, created_at, ended_at)
      VALUES (${seed.id}, ${projectId}, 'fixture', '{}', 'fake', ${seed.workspace ?? '{}'}, ${seed.status}, '2026-10-02T00:00:00.000Z', ${seed.endedAt ?? null})`.pipe(
      Effect.mapError(toStoreError),
    )
  })

export interface ProvisionOptions {
  readonly title?: string
  readonly baseBranch?: string
  readonly runtimeId?: string
}

// A session row and its workspace; the title, and so the branch, default to the id
export const provisionSession = (
  project: Project,
  seed: SessionSeed,
  options: ProvisionOptions = {},
): Effect.Effect<
  WorkspaceHandle,
  WorkspaceError | StoreError,
  SqlClient.SqlClient | WorkspaceManager
> =>
  Effect.gen(function* provisionsSession() {
    yield* seedSession(project.id, seed)
    const manager = yield* WorkspaceManager
    return yield* manager.provision({
      sessionId: seed.id,
      project,
      title: options.title ?? seed.id,
      baseBranch: options.baseBranch ?? 'main',
      runtimeId: options.runtimeId ?? 'local',
    })
  })

// A commit on the session branch that nothing has merged
export function commitUnmerged(handle: WorkspaceHandle): void {
  writeFileSync(path.join(handle.path, 'work.txt'), 'x')
  git(handle.path, 'add', 'work.txt')
  git(handle.path, 'commit', '-q', '-m', 'unmerged work')
}

// The code of a workspace error, the word store for any other failure of the manager
export const codeOf = (error: WorkspaceError | StoreError): string =>
  error instanceof WorkspaceError ? error.code : 'store'

// The workspace record of a session as the row holds it
export const storedWorkspaceOf = (
  sessionId: string,
): Effect.Effect<unknown, StoreError | Cause.NoSuchElementError, SqlClient.SqlClient> =>
  Effect.gen(function* readsWorkspace() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{
      readonly workspace_json: string
    }>`SELECT workspace_json FROM sessions WHERE id = ${sessionId}`.pipe(
      Effect.mapError(toStoreError),
    )
    const row = yield* Effect.fromNullishOr(rows[0])
    const stored: unknown = JSON.parse(row.workspace_json)
    return stored
  })

export interface SeenEvent {
  readonly type: string
  readonly projectId?: string
  readonly payload: unknown
}

// The project id is left out of an event that has none, so an expectation need not spell out a missing one
const seen = (event: SeenEvent): SeenEvent => ({
  type: event.type,
  ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
  payload: event.payload,
})

// What the event log holds for a session, oldest first
export const eventsOf = (
  sessionId: string,
): Effect.Effect<readonly SeenEvent[], StoreError, EventLog> =>
  Effect.gen(function* readsEvents() {
    const log = yield* EventLog
    const events = yield* log.read({ sessionId }, { from: 0 })
    return events.map((event) => seen(event))
  })
