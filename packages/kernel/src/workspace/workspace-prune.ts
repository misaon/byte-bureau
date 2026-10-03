import type { WorkspaceHandle, WorkspaceStatus } from '@bytebureau/plugin-api'
import { Clock, Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { StoreError, WorkspaceError } from '../errors.js'
import { RETAINED } from './retain-reasons.js'
import { loadWorkspaces, type Workspace } from './workspace-records.js'

export interface PruneReport {
  readonly removed: readonly string[]
  readonly retained: readonly { readonly path: string; readonly reason: string }[]
}

// What destroy did: the worktree went, or it stayed for the reason given
export type DestroyOutcome =
  | { readonly removed: true }
  | { readonly removed: false; readonly reason: string }

// What pruning asks of the manager it belongs to
export interface Actions {
  readonly status: (handle: WorkspaceHandle) => Effect.Effect<WorkspaceStatus, WorkspaceError>
  readonly destroy: (
    sessionId: string,
    handle: WorkspaceHandle,
    options: { readonly force: boolean },
  ) => Effect.Effect<DestroyOutcome, WorkspaceError | StoreError>
}

type Verdict =
  | { readonly outcome: 'removed'; readonly path: string }
  | { readonly outcome: 'retained'; readonly path: string; readonly reason: string }

const TERMINAL = new Set(['completed', 'stopped', 'errored'])
const DAY_MS = 86_400_000

const removed = (path: string): Verdict => ({ outcome: 'removed', path })
const retained = (path: string, reason: string): Verdict => ({ outcome: 'retained', path, reason })

// Reasons are sentences: a user reads them in the report of `workspaces prune`

// A session without a readable end time has not been over for any length of time
const endedLongAgo = (workspace: Workspace, now: number): boolean =>
  workspace.endedAt !== null && now - Date.parse(workspace.endedAt) >= workspace.retainDays * DAY_MS

// What the session record says: the session may still continue, or it ended too recently
const staleReason = (workspace: Workspace, now: number): string | undefined => {
  if (!TERMINAL.has(workspace.sessionStatus)) {
    return `session is ${workspace.sessionStatus}`
  }
  return endedLongAgo(workspace, now) ? undefined : `younger than ${workspace.retainDays} days`
}

// What git says: work that is saved nowhere else; a pushed branch, or one merged on the remote, is saved there
const unsavedReason = (current: WorkspaceStatus): string | undefined => {
  if (current.dirty) {
    return RETAINED.uncommitted
  }
  return current.ahead > 0 && !current.pushed ? RETAINED.notOnRemote : undefined
}

// Destroy checks again, so a worktree that changed since the status stays; one the runtime refuses to remove stays with the runtime's reason
const removeOrKeep = (
  actions: Actions,
  { sessionId, handle }: Workspace,
): Effect.Effect<Verdict, StoreError> =>
  actions.destroy(sessionId, handle, { force: false }).pipe(
    Effect.map((outcome) =>
      outcome.removed ? removed(handle.path) : retained(handle.path, outcome.reason),
    ),
    Effect.catchTag('WorkspaceError', (failure) =>
      Effect.succeed(retained(handle.path, failure.reason)),
    ),
  )

const pruneOne = (
  actions: Actions,
  workspace: Workspace,
  now: number,
): Effect.Effect<Verdict, StoreError> =>
  Effect.gen(function* pruneWorkspace() {
    const { handle } = workspace
    const stale = staleReason(workspace, now)
    if (stale !== undefined) {
      return retained(handle.path, stale)
    }
    const unsaved = yield* actions.status(handle).pipe(
      Effect.match({
        onFailure: () => RETAINED.statusUnavailable,
        onSuccess: (current) => unsavedReason(current),
      }),
    )
    if (unsaved !== undefined) {
      return retained(handle.path, unsaved)
    }
    return yield* removeOrKeep(actions, workspace)
  })

const reportOf = (verdicts: readonly Verdict[]): PruneReport => ({
  removed: verdicts.flatMap((verdict) => (verdict.outcome === 'removed' ? [verdict.path] : [])),
  retained: verdicts.flatMap((verdict) =>
    verdict.outcome === 'retained' ? [{ path: verdict.path, reason: verdict.reason }] : [],
  ),
})

// A worktree that is already gone has nothing left to prune, and no line in the report
const present = (workspaces: readonly Workspace[]): readonly Workspace[] =>
  workspaces.filter((workspace) => workspace.exists)

// One worktree at a time, so a prune never runs several git commands at once
export const makePrune =
  (
    sql: SqlClient.SqlClient,
    actions: Actions,
  ): ((projectId?: string) => Effect.Effect<PruneReport, StoreError>) =>
  (projectId) =>
    Effect.gen(function* pruneWorkspaces() {
      const now = yield* Clock.currentTimeMillis
      const workspaces = yield* loadWorkspaces(sql, projectId)
      const verdicts = yield* Effect.forEach(
        present(workspaces),
        (workspace) => pruneOne(actions, workspace, now),
        { concurrency: 1 },
      )
      return reportOf(verdicts)
    })
