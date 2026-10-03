import type { AnsweredVia, Ask, AskAnswer, AskRecord } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { StoreError } from '../errors.js'
import type { EventLogShape } from '../events/event-log.js'

// How an ask got its answer; a fallback means the timeout of the policy produced it
export interface Settlement {
  readonly answer: AskAnswer
  readonly via: AnsweredVia
  readonly fallback?: string | undefined
}

// The ids that tie an event to its ask; the turn is left out when the ask has none
const idsOf = (ask: Ask): { readonly sessionId: string; readonly turnId?: string } => ({
  sessionId: ask.sessionId,
  ...(ask.turnId === null ? {} : { turnId: ask.turnId }),
})

export const announceRequest = (log: EventLogShape, ask: Ask): Effect.Effect<void, StoreError> =>
  Effect.asVoid(log.publish({ type: 'ask.requested', ...idsOf(ask), payload: { ask } }))

// A timeout is announced as the expiry with its fallback, then as the answer it produced
export const announceAnswer = (
  log: EventLogShape,
  ask: AskRecord,
  { answer, via, fallback }: Settlement,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* announcesAnswer() {
    if (fallback !== undefined) {
      yield* log.publish({
        type: 'ask.expired',
        ...idsOf(ask),
        payload: { askId: ask.id, fallback },
      })
    }
    yield* log.publish({
      type: 'ask.answered',
      ...idsOf(ask),
      payload: { askId: ask.id, answer, answeredVia: via },
    })
  })

export const announceCancel = (
  log: EventLogShape,
  ask: AskRecord,
): Effect.Effect<void, StoreError> =>
  Effect.asVoid(log.publish({ type: 'ask.cancelled', ...idsOf(ask), payload: { askId: ask.id } }))
