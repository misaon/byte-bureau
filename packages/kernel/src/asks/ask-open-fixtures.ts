import type { Ask } from '@bytebureau/protocol'
import { Effect, type Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import type { StoreError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import { buildAsk, type OpenAskInput } from './ask-build.js'
import type { OpenDeps } from './ask-open.js'
import { insertAsk } from './ask-records.js'
import { seedSession } from './ask-service-fixtures.js'
import { park } from './ask-waiters.js'

export interface ParkedAsk {
  readonly deps: OpenDeps
  readonly ask: Ask
}

// An ask, stored and with its waiter parked, and the deps a timer needs
export const parkedAsk = (
  input: OpenAskInput,
): Effect.Effect<ParkedAsk, StoreError, SqlClient.SqlClient | EventLog | Scope.Scope> =>
  Effect.gen(function* parksAsk() {
    yield* seedSession(input.sessionId)
    const sql = yield* SqlClient.SqlClient
    const log = yield* EventLog
    const scope = yield* Effect.scope
    const deps: OpenDeps = { sql, log, scope, waiters: new Map() }
    const ask = buildAsk(input)
    yield* insertAsk(sql, ask)
    yield* park(deps.waiters, ask.id)
    return { deps, ask }
  })
