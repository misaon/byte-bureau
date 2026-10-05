import { existsSync } from 'node:fs'
import path from 'node:path'
import { Effect, type Cause } from 'effect'
import { SessionError, WorkspaceError, type StoreError } from '../errors.js'
import { WorkspaceManager } from '../workspace/workspace-manager.js'
import type { Session } from './types.js'

// The directory of the worktree of a session, empty for a session that has none
export const workspaceOf = (session: Session): string =>
  session.workspace === null ? '' : session.workspace.path

// The file the hello script of the fake agent writes
export const helloFileOf = (session: Session): string =>
  path.join(workspaceOf(session), 'src', 'hello.ts')

// How a refusal reads: the code of the error and its reason
const describeFailure = (failure: unknown): string =>
  failure instanceof SessionError || failure instanceof WorkspaceError
    ? `${failure.code}: ${failure.reason}`
    : String(failure)

// The refusal an attempt ends with, described; an attempt that succeeds fails the test that expects its refusal
export const refusalOf = <Value>(
  attempt: Effect.Effect<Value, unknown>,
): Effect.Effect<string, unknown> => Effect.map(Effect.flip(attempt), describeFailure)

// The first of a list, which a test that expects one has a failure for when there is none
export const firstOf = <Item>(
  items: readonly Item[],
): Effect.Effect<Item, Cause.NoSuchElementError> => Effect.fromNullishOr(items[0])

// Lets every fiber that can run do so a few times over, which is how a test shows that something has not happened
export const flush: Effect.Effect<void> = Effect.forEach(
  Array.from({ length: 20 }),
  () => Effect.yieldNow,
  { discard: true },
)

// How many of the types are the given one
export const countOf = (types: readonly string[], type: string): number =>
  types.filter((candidate) => candidate === type).length

// Whether the worktree of the session was on disk and held by no running session: then force removes it
export const freeWorktree = (
  session: Session,
): Effect.Effect<
  boolean,
  WorkspaceError | StoreError | Cause.NoSuchElementError,
  WorkspaceManager
> =>
  Effect.gen(function* removesFreeWorktree() {
    const workspaces = yield* WorkspaceManager
    const handle = yield* Effect.fromNullishOr(session.workspace)
    const kept = existsSync(handle.path)
    const outcome = yield* workspaces.destroy(session.id, handle, { force: true })
    return kept && outcome.removed && !existsSync(handle.path)
  })
