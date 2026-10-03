import type { WorkspaceHandle, WorkspaceSpec } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import type { StoreError, WorkspaceError } from '../errors.js'
import type { EventLogShape } from '../events/event-log.js'
import { kernelLogger } from '../logging/logging.js'
import type { Project } from '../projects/project-registry.js'
import { provisionOn, runtimeFor, type WorkspaceRuntimesShape } from './runtimes.js'
import { branchSlug } from './slug.js'
import { saveHandle } from './workspace-records.js'

export interface ProvisionInput {
  readonly sessionId: string
  readonly project: Project
  readonly title: string
  readonly baseBranch: string
  readonly runtimeId: string
}

const workspaceLogger = kernelLogger(['bb', 'workspace'])

// Both the workspace section and its list are optional in a project's configuration
const copyIgnoredOf = ({ config }: Project): readonly string[] => {
  const { workspace } = config
  return workspace === undefined ? [] : (workspace.copyIgnored ?? [])
}

const specOf = (input: ProvisionInput): WorkspaceSpec => ({
  sessionId: input.sessionId,
  projectPath: input.project.path,
  baseBranch: input.baseBranch,
  branch: branchSlug(input.title, input.sessionId),
  copyIgnored: copyIgnoredOf(input.project),
  logger: workspaceLogger,
})

const announce = (
  log: EventLogShape,
  input: ProvisionInput,
  handle: WorkspaceHandle,
): Effect.Effect<void, StoreError> =>
  Effect.asVoid(
    log.publish({
      type: 'workspace.provisioned',
      sessionId: input.sessionId,
      projectId: input.project.id,
      payload: {
        path: handle.path,
        branch: handle.branch,
        baseRef: handle.baseRef,
        runtimeId: handle.runtimeId,
      },
    }),
  )

// The runtime makes the worktree, the session row keeps the handle, the event log announces it
export const makeProvision =
  (
    sql: SqlClient.SqlClient,
    log: EventLogShape,
    runtimes: WorkspaceRuntimesShape,
  ): ((input: ProvisionInput) => Effect.Effect<WorkspaceHandle, WorkspaceError | StoreError>) =>
  (input) =>
    Effect.gen(function* provisionWorkspace() {
      const runtime = yield* runtimeFor(runtimes, input.runtimeId)
      const handle = yield* provisionOn(runtime, specOf(input))
      yield* saveHandle(sql, input.sessionId, handle)
      yield* announce(log, input, handle)
      return handle
    })
