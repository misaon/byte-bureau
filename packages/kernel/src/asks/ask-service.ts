import type { AnsweredVia, AskAnswer, AskRecord } from '@bytebureau/protocol'
import { Context, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'
import type { AskError, StoreError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import type { OpenAskInput } from './ask-build.js'
import { openAsk, type OpenDeps } from './ask-open.js'
import { listPending, loadAsk } from './ask-records.js'
import { answerAsk, cancelAsk } from './ask-settle.js'
import { awaitAnswer, closeWaiters } from './ask-waiters.js'

export type { OpenAskInput } from './ask-build.js'
export { DENY_ON_TIMEOUT_MESSAGE } from './ask-build.js'

export interface AskServiceShape {
  readonly open: (input: OpenAskInput) => Effect.Effect<AskRecord, StoreError>
  readonly answer: (
    askId: string,
    answer: AskAnswer,
    via: AnsweredVia,
  ) => Effect.Effect<AskRecord, AskError | StoreError>
  readonly cancel: (askId: string) => Effect.Effect<void, StoreError>
  readonly pending: (sessionId?: string) => Effect.Effect<readonly AskRecord[], StoreError>
  // An ask pending or settled, and nothing for an id nobody holds
  readonly get: (askId: string) => Effect.Effect<AskRecord | undefined, StoreError>
  readonly await: (askId: string) => Effect.Effect<AskAnswer, AskError>
}

export class AskService extends Context.Service<AskService, AskServiceShape>()('bb/AskService') {}

const make = Effect.gen(function* makeAskService() {
  const sql = yield* SqlClient.SqlClient
  const log = yield* EventLog
  const scope = yield* Effect.scope
  const deps: OpenDeps = { sql, log, scope, waiters: new Map() }
  yield* Effect.addFinalizer(() => closeWaiters(deps.waiters))
  return AskService.of({
    open: (input) => openAsk(deps, input),
    answer: (askId, answer, via) => answerAsk(deps, askId, { answer, via }),
    cancel: (askId) => cancelAsk(deps, askId),
    pending: (sessionId) => listPending(sql, sessionId),
    get: (askId) => loadAsk(sql, askId),
    await: (askId) => awaitAnswer(deps.waiters, askId),
  })
})

export const AskServiceLive: Layer.Layer<AskService, never, SqlClient.SqlClient | EventLog> =
  Layer.effect(AskService, make)
