import type { Ask, AskAnswer, AskRecord } from '@bytebureau/protocol'
import { Effect, Exit } from 'effect'
import type { SqlClient } from 'effect/sql'
import { AskError, type StoreError } from '../errors.js'
import type { EventLogShape } from '../events/event-log.js'
import { nowIso } from '../ids.js'
import { timeoutAnswer } from './ask-build.js'
import { announceAnswer, announceCancel, type Settlement } from './ask-events.js'
import { claimAnswer, claimCancel, loadAsk } from './ask-records.js'
import { wake, type Waiters } from './ask-waiters.js'

// What a waiter learns when its ask is cancelled
const cancelled = (askId: string): Exit.Exit<never, AskError> =>
  Exit.fail(new AskError({ code: 'not_pending', reason: `ask ${askId} is cancelled` }))

export interface AskDeps {
  readonly sql: SqlClient.SqlClient
  readonly log: EventLogShape
  readonly waiters: Waiters
}

// The waiter is woken after the announcement, so whoever waits finds the answer in the log, and even when the announcement fails
const deliver = (
  deps: AskDeps,
  record: AskRecord,
  settlement: Settlement,
): Effect.Effect<void, StoreError> => {
  const outcome = Exit.succeed(settlement.answer)
  return announceAnswer(deps.log, record, settlement).pipe(
    Effect.ensuring(wake(deps.waiters, record.id, outcome)),
  )
}

// The first claim of a pending ask wins and returns the answered record, any later one returns nothing
// Nothing may interrupt the steps after the claim: an answer that is stored must also arrive
// The time is read when the effect runs, not when it is built, because the timer builds it long before
const settle = (
  deps: AskDeps,
  askId: string,
  settlement: Settlement,
): Effect.Effect<AskRecord | undefined, StoreError> =>
  Effect.gen(function* settlesAsk() {
    const claim = { answer: settlement.answer, via: settlement.via, answeredAt: nowIso() }
    const record = yield* claimAnswer(deps.sql, askId, claim)
    if (record !== undefined) {
      yield* deliver(deps, record, settlement)
    }
    return record
  }).pipe(Effect.uninterruptible)

// The timer's turn: the policy answers unless somebody was quicker
export const expire = (deps: AskDeps, ask: Ask): Effect.Effect<void, StoreError> =>
  Effect.asVoid(
    settle(deps, ask.id, {
      answer: timeoutAnswer(ask),
      via: 'timeout',
      fallback: ask.policy.onTimeout,
    }),
  )

// An ask that cannot be answered is told apart: one that never existed, or one that is not pending any more
const refusalOf = (askId: string, record: AskRecord | undefined): AskError =>
  record === undefined
    ? new AskError({ code: 'not_found', reason: `ask ${askId} does not exist` })
    : new AskError({ code: 'not_pending', reason: `ask ${askId} is ${record.status}` })

// An answer picks options the ask offers, or words of its own where a question allows them
const invalidity = (ask: Ask, answer: AskAnswer): string | undefined => {
  if (answer.selected === 'other') {
    const open = ask.questions.some((question) => question.allowOther)
    return open ? undefined : `ask ${ask.id} takes no answer of its own`
  }
  const offered = new Set(
    ask.questions.flatMap((question) => question.options.map((option) => option.id)),
  )
  const unknown = answer.selected.filter((id) => !offered.has(id))
  return unknown.length === 0 ? undefined : `ask ${ask.id} has no option ${unknown.join(', ')}`
}

// The ask is read first, so a refusal or an answer that does not fit changes nothing; the claim still decides a race
export const answerAsk = (
  deps: AskDeps,
  askId: string,
  settlement: Settlement,
): Effect.Effect<AskRecord, AskError | StoreError> =>
  Effect.gen(function* answersAsk() {
    const current = yield* loadAsk(deps.sql, askId)
    if (current === undefined || current.status !== 'pending') {
      return yield* refusalOf(askId, current)
    }
    const invalid = invalidity(current, settlement.answer)
    if (invalid !== undefined) {
      return yield* new AskError({ code: 'invalid_answer', reason: invalid })
    }
    const record = yield* settle(deps, askId, settlement)
    return record ?? (yield* refusalOf(askId, yield* loadAsk(deps.sql, askId)))
  })

// Cancelling an ask that is not pending does nothing; a waiter fails with the cancellation, even when it cannot be announced
export const cancelAsk = (deps: AskDeps, askId: string): Effect.Effect<void, StoreError> =>
  Effect.gen(function* cancelsAsk() {
    const record = yield* claimCancel(deps.sql, askId)
    if (record === undefined) {
      return
    }
    const outcome = cancelled(askId)
    yield* announceCancel(deps.log, record).pipe(
      Effect.ensuring(wake(deps.waiters, askId, outcome)),
    )
  }).pipe(Effect.uninterruptible)

// An ask whose request could not be announced was offered to nobody: it is cancelled without an event and its waiter fails
export const withdrawAsk = (deps: AskDeps, askId: string): Effect.Effect<void, StoreError> => {
  const outcome = cancelled(askId)
  return claimCancel(deps.sql, askId).pipe(
    Effect.ensuring(wake(deps.waiters, askId, outcome)),
    Effect.asVoid,
  )
}
