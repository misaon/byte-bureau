import type { AskAnswer } from '@bytebureau/protocol'
import { Deferred, Effect, type Exit } from 'effect'
import { AskError } from '../errors.js'

// What a caller of await waits on; an entry stays after its ask is settled, so a late caller still gets the outcome
export type Waiters = Map<string, Deferred.Deferred<AskAnswer, AskError>>

export const park = (waiters: Waiters, askId: string): Effect.Effect<void> =>
  Effect.map(Deferred.make<AskAnswer, AskError>(), (waiter) => {
    waiters.set(askId, waiter)
  })

export const wake = (
  waiters: Waiters,
  askId: string,
  outcome: Exit.Exit<AskAnswer, AskError>,
): Effect.Effect<void> => {
  const waiter = waiters.get(askId)
  return waiter === undefined ? Effect.void : Effect.asVoid(Deferred.done(waiter, outcome))
}

export const awaitAnswer = (
  waiters: Waiters,
  askId: string,
): Effect.Effect<AskAnswer, AskError> => {
  const waiter = waiters.get(askId)
  return waiter === undefined
    ? Effect.fail(
        new AskError({ code: 'not_found', reason: `ask ${askId} was not opened by this process` }),
      )
    : Deferred.await(waiter)
}
