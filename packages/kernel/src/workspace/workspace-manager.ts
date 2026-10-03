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
import { makeProvision, type ProvisionInput } from './workspace-provision.js'
import { makePrune, type PruneReport } from './workspace-prune.js'
import { listWorkspaces, type WorkspaceInfo } from './workspace-records.js'

export type { ProvisionInput } from './workspace-provision.js'
export type { PruneReport } from './workspace-prune.js'
export type { WorkspaceInfo } from './workspace-records.js'

export interface WorkspaceManagerShape {
  readonly provision: (
    input: ProvisionInput,
  ) => Effect.Effect<WorkspaceHandle, WorkspaceError | StoreError>
  readonly status: (handle: WorkspaceHandle) => Effect.Effect<WorkspaceStatus, WorkspaceError>
  readonly destroy: (
    handle: WorkspaceHandle,
    options?: { readonly force?: boolean },
  ) => Effect.Effect<void, WorkspaceError | StoreError>
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
  handle: WorkspaceHandle,
): Effect.Effect<void, WorkspaceError> =>
  locks.has(handle.id)
    ? Effect.fail(new WorkspaceError({ code: 'locked', reason: `session ${handle.id} is running` }))
    : Effect.void

// Without force a worktree goes only when its status says that nothing in it is lost
const keepReason = (
  runtime: WorkspaceRuntime,
  handle: WorkspaceHandle,
): Effect.Effect<string | undefined> =>
  statusOn(runtime, handle).pipe(
    Effect.match({
      onFailure: () => 'status unavailable',
      onSuccess: (current) => (current.dirty ? 'uncommitted changes' : undefined),
    }),
  )

// A kept worktree is announced with its reason; force skips the status and the runtime still refuses a locked worktree
const makeDestroy =
  (
    log: EventLogShape,
    runtimes: WorkspaceRuntimesShape,
    locks: ReadonlySet<string>,
  ): WorkspaceManagerShape['destroy'] =>
  (handle, options = {}) =>
    Effect.gen(function* destroyWorkspace() {
      yield* refuseLocked(locks, handle)
      const runtime = yield* runtimeFor(runtimes, handle.runtimeId)
      const reason = options.force === true ? undefined : yield* keepReason(runtime, handle)
      if (reason !== undefined) {
        yield* log.publish({
          type: 'workspace.retained',
          sessionId: handle.id,
          payload: { path: handle.path, reason },
        })
        return
      }
      yield* destroyOn(runtime, handle, options)
      yield* log.publish({
        type: 'workspace.destroyed',
        sessionId: handle.id,
        payload: { path: handle.path },
      })
    })

const make = Effect.gen(function* makeWorkspaceManager() {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const runtimes = yield* WorkspaceRuntimes
  // Sessions that are running; the set lives as long as the layer
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
