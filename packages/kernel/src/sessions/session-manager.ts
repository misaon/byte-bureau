import { Context, Effect, Layer } from 'effect'
import { collectDeps, type SessionRequirements } from './session-collect.js'
import type { SessionDeps } from './session-deps.js'
import { makeCreate } from './session-create.js'
import { makeComplete, makeInterrupt, makeResume, makeStop } from './session-end.js'
import { dispose, releaseFibers } from './session-live.js'
import { makePrompt } from './session-prompt.js'
import { listSessions, loadSession } from './session-records.js'
import type { SessionManagerShape } from './session-shape.js'

export type { SessionManagerShape } from './session-shape.js'

export class SessionManager extends Context.Service<SessionManager, SessionManagerShape>()(
  'bb/SessionManager',
) {}

// Releasing the layer lets every provider session go, so no agent outlives the kernel
// The agents are closed before the pumps are interrupted: the events of an agent end when it closes, and a pump waits for them
const closeAll = (deps: SessionDeps): Effect.Effect<void> =>
  Effect.forEach(deps.live.all(), (live) => dispose(deps, live), { discard: true }).pipe(
    Effect.andThen(releaseFibers(deps.scope)),
  )

const make = Effect.gen(function* makeSessionManager() {
  const deps = yield* collectDeps
  yield* Effect.addFinalizer(() => closeAll(deps))
  return SessionManager.of({
    create: makeCreate(deps),
    prompt: makePrompt(deps),
    interrupt: makeInterrupt(deps),
    stop: makeStop(deps),
    complete: makeComplete(deps),
    resume: makeResume(deps),
    list: () => listSessions(deps.sql),
    get: (id) => loadSession(deps.sql, id),
  })
})

export const SessionManagerLive: Layer.Layer<SessionManager, never, SessionRequirements> =
  Layer.effect(SessionManager, make)
