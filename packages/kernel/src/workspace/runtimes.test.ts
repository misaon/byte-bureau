import type { WorkspaceRuntime } from '@bytebureau/plugin-api'
import { WorkspaceError as PluginWorkspaceError } from '@bytebureau/workspace-local'
import { assert, describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { WorkspaceError } from '../errors.js'
import { runtimeFor, toWorkspaceError, type WorkspaceRuntimesShape } from './runtimes.js'

const known = new Map<string, WorkspaceRuntime>()
const empty: WorkspaceRuntimesShape = {
  get: (id) => known.get(id),
  list: () => [...known.values()],
}

// Equality of errors in chai looks at the name, the message and the code, and a tagged error has no message
const fieldsOf = (error: WorkspaceError): readonly string[] => [error.code, error.reason]

describe(toWorkspaceError, () => {
  it('keeps the code and the message of an error a runtime throws', () => {
    const thrown = new PluginWorkspaceError('dirty', 'worktree has uncommitted changes')
    expect(fieldsOf(toWorkspaceError(thrown))).toStrictEqual([
      'dirty',
      'worktree has uncommitted changes',
    ])
  })

  it('takes any other failure for a failed git run', () => {
    const fromError = toWorkspaceError(new Error('boom'))
    const fromText = toWorkspaceError('plain text')
    expect(fieldsOf(fromError)).toStrictEqual(['git_failed', 'boom'])
    expect(fieldsOf(fromText)).toStrictEqual(['git_failed', 'plain text'])
  })
})

it.effect('fails with runtime_missing for an id no runtime has', () =>
  Effect.gen(function* refusesUnknownRuntime() {
    const error = yield* Effect.flip(runtimeFor(empty, 'nobody'))
    assert.deepStrictEqual(fieldsOf(error), [
      'runtime_missing',
      'workspace runtime "nobody" is not available',
    ])
  }),
)
