import type {
  WorkspaceHandle,
  WorkspaceRuntime,
  WorkspaceSpec,
  WorkspaceStatus,
} from '@bytebureau/plugin-api'
import { Context, Effect } from 'effect'
import { WorkspaceError } from '../errors.js'

export interface WorkspaceRuntimesShape {
  readonly get: (id: string) => WorkspaceRuntime | undefined
  readonly list: () => readonly WorkspaceRuntime[]
}

export class WorkspaceRuntimes extends Context.Service<WorkspaceRuntimes, WorkspaceRuntimesShape>()(
  'bb/WorkspaceRuntimes',
) {}

// The plugin's WorkspaceError carries a code; any other failure counts as a failed git run
const hasCode = (cause: unknown): cause is Error & { readonly code: string } =>
  cause instanceof Error && 'code' in cause && typeof cause.code === 'string'

export const toWorkspaceError = (cause: unknown): WorkspaceError => {
  if (hasCode(cause)) {
    return new WorkspaceError({ code: cause.code, reason: cause.message })
  }
  const reason = cause instanceof Error ? cause.message : String(cause)
  return new WorkspaceError({ code: 'git_failed', reason })
}

export const runtimeFor = (
  runtimes: WorkspaceRuntimesShape,
  id: string,
): Effect.Effect<WorkspaceRuntime, WorkspaceError> => {
  const runtime = runtimes.get(id)
  if (runtime === undefined) {
    const reason = `workspace runtime "${id}" is not available`
    return Effect.fail(new WorkspaceError({ code: 'runtime_missing', reason }))
  }
  return Effect.succeed(runtime)
}

// The runtime port speaks promises and throws; the kernel speaks typed failures
const attempt = <Value>(call: () => Promise<Value>): Effect.Effect<Value, WorkspaceError> =>
  Effect.tryPromise({ try: call, catch: toWorkspaceError })

export const provisionOn = (
  runtime: WorkspaceRuntime,
  spec: WorkspaceSpec,
): Effect.Effect<WorkspaceHandle, WorkspaceError> =>
  attempt(async () => {
    const handle = await runtime.provision(spec)
    return handle
  })

export const statusOn = (
  runtime: WorkspaceRuntime,
  handle: WorkspaceHandle,
): Effect.Effect<WorkspaceStatus, WorkspaceError> =>
  attempt(async () => {
    const status = await runtime.status(handle)
    return status
  })

export const destroyOn = (
  runtime: WorkspaceRuntime,
  handle: WorkspaceHandle,
  options: { readonly force?: boolean },
): Effect.Effect<void, WorkspaceError> =>
  attempt(async () => {
    await runtime.destroy(handle, options)
  })
