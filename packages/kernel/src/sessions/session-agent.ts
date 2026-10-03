import { Effect } from 'effect'
import type { ProviderError, SessionError, StoreError } from '../errors.js'
import type { Live } from './live-sessions.js'
import { connect } from './session-connect.js'
import type { SessionDeps } from './session-deps.js'
import { rememberRef } from './session-live.js'
import { pumpOf } from './session-pump.js'
import type { Session } from './types.js'

// The events of the provider session are pumped for as long as it lives, which is as long as the layer at most
const start = (deps: SessionDeps, live: Live): Effect.Effect<Live, StoreError> =>
  Effect.gen(function* startsLive() {
    deps.live.add(live)
    live.pump = yield* Effect.forkIn(pumpOf(deps, live), deps.scope)
    yield* rememberRef(deps, live)
    return live
  })

// The provider session of a session: started once, and the one that is attached already when there is one
export const attach = (
  deps: SessionDeps,
  session: Session,
): Effect.Effect<Live, SessionError | ProviderError | StoreError> => {
  const existing = deps.live.get(session.id)
  return existing === undefined
    ? Effect.flatMap(connect(deps, session), (live) => start(deps, live))
    : Effect.succeed(existing)
}
