import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { Effect } from 'effect'
import type { SqlClient } from 'effect/sql'
import { ConfigError } from '../errors.js'
import type { PluginHost } from '../plugins/plugin-host.js'
import { ProjectRegistry } from '../projects/project-registry.js'
import { turnsOf } from './session-db-fixtures.js'
import { startSession } from './session-fixtures.js'
import { SessionManager } from './session-manager.js'

export interface Refused {
  readonly error: unknown
  readonly repo: string
  readonly turns: number
}

// What the prompt of a fresh session of the project fails with; the local file is written once the project is registered
export const refusedIn = (
  config: Readonly<Record<string, unknown>>,
  local?: Readonly<Record<string, unknown>>,
): Effect.Effect<
  Refused,
  unknown,
  SessionManager | PluginHost | ProjectRegistry | SqlClient.SqlClient
> =>
  Effect.gen(function* refusesPrompt() {
    const session = yield* startSession({ providerId: 'scripted' }, config)
    const project = yield* (yield* ProjectRegistry).get(session.projectId)
    const repo = project === undefined ? '' : project.path
    if (local !== undefined) {
      writeFileSync(path.join(repo, 'bytebureau.local.json'), JSON.stringify(local))
    }
    const error = yield* Effect.flip((yield* SessionManager).prompt(session.id, { text: 'go' }))
    return { error, repo, turns: (yield* turnsOf(session.id)).length }
  })

// Where the refusal says the section came from, and what it says
export const toldOf = ({ error }: Refused): readonly string[] =>
  error instanceof ConfigError ? [error.file, error.pointer, error.reason] : [String(error)]
