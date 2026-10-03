import type { WorkspaceHandle, WorkspaceRuntime, WorkspaceStatus } from '@bytebureau/plugin-api'
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import { WorkspaceError, type StoreError } from '../errors.js'
import { EventLog, type EventLogShape } from '../events/event-log.js'
import {
  destroyOn,
  runtimeFor,
  statusOn,
  WorkspaceRuntimes,
  type WorkspaceRuntimesShape,
} from './runtimes.js'
import { RETAINED } from './retain-reasons.js'
import { makeProvision, type ProvisionInput } from './workspace-provision.js'
import { makePrune, type DestroyOutcome, type PruneReport } from './workspace-prune.js'
import { listWorkspaces, type WorkspaceInfo } from './workspace-records.js'

export type { ProvisionInput } from './workspace-provision.js'
export type { PruneReport } from './workspace-prune.js'
export type { WorkspaceInfo } from './workspace-records.js'

export interface WorkspaceManagerShape {
  readonly provision: (
    input: ProvisionInput,
  ) => Effect.Effect<WorkspaceHandle, WorkspaceError | StoreError>
  readonly status: (handle: WorkspaceHandle) => Effect.Effect<WorkspaceStatus, WorkspaceError>
  // The session id is the one the manager knows, never read back from the handle a runtime returned
  readonly destroy: (
    sessionId: string,
    handle: WorkspaceHandle,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<DestroyOutcome, WorkspaceError | StoreError>
  readonly lock: (sessionId: string) => Effect.Effect<void>
  readonly unlock: (sessionId: string) => Effect.Effect<void>
  readonly list: (projectId?: string) => Effect.Effect<readonly WorkspaceInfo[], StoreError>
  readonly prune: (projectId?: string) => Effect.Effect<PruneReport, StoreError>
}

export class WorkspaceManager extends Context.Service<WorkspaceManager, WorkspaceManagerShape>()(
  'bb/WorkspaceManager',
) {}

const makeStatus =
  (runtimes: WorkspaceRuntimesShape): WorkspaceManagerShape['status'] =>
  (handle) =>
    runtimeFor(runtimes, handle.runtimeId).pipe(
      Effect.flatMap((runtime) => statusOn(runtime, handle)),
    )

// A running session keeps its worktree, whatever force says
const refuseLocked = (
  locks: ReadonlySet<string>,
  sessionId: string,
): Effect.Effect<void, WorkspaceError> =>
  locks.has(sessionId)
    ? Effect.fail(new WorkspaceError({ code: 'locked', reason: `session ${sessionId} is running` }))
    : Effect.void

// Without force a worktree goes only when its status says that nothing in it is lost
const keepReason = (
  runtime: WorkspaceRuntime,
  handle: WorkspaceHandle,
): Effect.Effect<string | undefined> =>
  statusOn(runtime, handle).pipe(
    Effect.match({
      onFailure: () => RETAINED.statusUnavailable,
      onSuccess: (current) => (current.dirty ? RETAINED.uncommitted : undefined),
    }),
  )

// A kept worktree is announced with its reason; force skips the status and the runtime still refuses a locked worktree
// The outcome says whether the worktree went, so a caller that checked the status before cannot report it gone when it stayed
const makeDestroy =
  (
    log: EventLogShape,
    runtimes: WorkspaceRuntimesShape,
    locks: ReadonlySet<string>,
  ): WorkspaceManagerShape['destroy'] =>
  (sessionId, handle, options = {}) =>
    Effect.gen(function* destroyWorkspace() {
      yield* refuseLocked(locks, sessionId)
      const runtime = yield* runtimeFor(runtimes, handle.runtimeId)
      const reason = options.force === true ? undefined : yield* keepReason(runtime, handle)
      if (reason !== undefined) {
        const payload = { path: handle.path, reason }
        yield* log.publish({ type: 'workspace.retained', sessionId, payload })
        return { removed: false, reason } as const
      }
      yield* destroyOn(runtime, handle, options)
      yield* log.publish({ type: 'workspace.destroyed', sessionId, payload: { path: handle.path } })
      return { removed: true } as const
    })

const make = Effect.gen(function* makeWorkspaceManager() {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const runtimes = yield* WorkspaceRuntimes
  // The sessions that are running, by session id; the set belongs to this process and lives as long as the layer
  const locks = new Set<string>()
  const status = makeStatus(runtimes)
  const destroy = makeDestroy(log, runtimes, locks)
  return WorkspaceManager.of({
    provision: makeProvision(sql, log, runtimes),
    status,
    destroy,
    lock: (sessionId) =>
      Effect.sync(() => {
        locks.add(sessionId)
      }),
    unlock: (sessionId) =>
      Effect.sync(() => {
        locks.delete(sessionId)
      }),
    list: (projectId) => listWorkspaces(sql, projectId),
    prune: makePrune(sql, { status, destroy }),
  })
})

export const WorkspaceManagerLive: Layer.Layer<
  WorkspaceManager,
  never,
  SqlClient.SqlClient | EventLog | WorkspaceRuntimes
> = Layer.effect(WorkspaceManager, make)
