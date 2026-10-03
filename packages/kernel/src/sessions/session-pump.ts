import { Effect, Stream } from 'effect'
import { ProviderError, type StoreError } from '../errors.js'
import { reasonOf } from '../plugins/reason.js'
import type { Live } from './live-sessions.js'
import type { SessionDeps } from './session-deps.js'
import { handleEvent } from './session-handler.js'
import { dispose, failSession, reported } from './session-live.js'
import { loadSession } from './session-records.js'
import { transition } from './state-machine.js'

const iteratorFailure = (cause: unknown): ProviderError =>
  new ProviderError({ kind: 'protocol', reason: reasonOf(cause), retryable: false })

// A turn that was running is lost with the provider session; an idle session only has to be attached again
const lose = (
  deps: SessionDeps,
  live: Live,
  reason: string | null,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* losesAgent() {
    const session = yield* loadSession(deps.sql, live.session.id)
    if (session !== undefined && transition(session.status, 'crash') !== null) {
      const message = reason ?? 'the agent closed its event stream'
      const kind = reason === null ? 'crash' : 'protocol'
      yield* failSession(deps, live, { kind, message, retryable: true })
    } else {
      yield* dispose(deps, live)
    }
  })

// The events ended, and the kernel did not close the provider session: the provider went away by itself
// A session the kernel has let go has nothing to lose, and is not waited for: its stop is what interrupts the pump
const ended = (deps: SessionDeps, live: Live, reason: string | null): Effect.Effect<void> =>
  live.closed
    ? Effect.void
    : deps.live
        .exclusive(
          live.session.id,
          Effect.suspend(() => (live.closed ? Effect.void : lose(deps, live, reason))),
        )
        .pipe(reported({ sessionId: live.session.id, event: 'events ended' }))

// Applies the events of the provider one after the other for as long as the provider session lives
// A provider that cannot even give its events has failed like one whose events fail
export const pumpOf = (deps: SessionDeps, live: Live): Effect.Effect<void> =>
  Effect.try({ try: () => live.agent.events(), catch: iteratorFailure }).pipe(
    Effect.flatMap((events) =>
      Stream.fromAsyncIterable(events, iteratorFailure).pipe(
        Stream.runForEach((event) => handleEvent(deps, live, event)),
      ),
    ),
    Effect.matchEffect({
      onFailure: (failure) => ended(deps, live, failure.reason),
      onSuccess: () => ended(deps, live, null),
    }),
  )
