import { Effect } from 'effect'
import type { StoreError } from '../errors.js'
import type { Live } from './live-sessions.js'
import { connect } from './session-connect.js'
import type { SessionDeps } from './session-deps.js'
import { rememberRef } from './session-live.js'
import { pumpOf } from './session-pump.js'
import type { StartFailure } from './session-start.js'
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
// The agent runs in this kernel from here on; the move to running names this kernel, so the recovery of another kernel leaves the session alone
export const attach = (deps: SessionDeps, session: Session): Effect.Effect<Live, StartFailure> => {
  const existing = deps.live.get(session.id)
  return existing === undefined
    ? Effect.flatMap(connect(deps, session), (live) => start(deps, live))
    : Effect.succeed(existing)
}
