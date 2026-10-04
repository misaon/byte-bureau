import { Context, Effect, Layer, type Scope } from 'effect'
import { LiveSessions, newInstance } from './live-sessions.js'
import { collectDeps, type SessionRequirements } from './session-collect.js'
import type { KernelEnv, SessionDeps } from './session-deps.js'
import { makeCreate } from './session-create.js'
import { makeComplete, makeInterrupt, makeRecover, makeResume, makeStop } from './session-end.js'
import { dispose, releaseFibers } from './session-live.js'
import { makePrompt } from './session-prompt.js'
import { listSessions, loadSession } from './session-records.js'
import type { SessionManagerShape } from './session-shape.js'

export type { SessionManagerShape } from './session-shape.js'

export class SessionManager extends Context.Service<SessionManager, SessionManagerShape>()(
  'bb/SessionManager',
) {}

// Releasing the layer lets every provider session go, so no agent outlives the kernel
// The agents are closed together, each within its own bound, and before the pumps are interrupted: the events of an agent end when it closes, and a pump waits for them
const closeAll = (deps: SessionDeps): Effect.Effect<void> =>
  Effect.forEach(deps.live.all(), (live) => dispose(deps, live), {
    discard: true,
    concurrency: 'unbounded',
  }).pipe(Effect.andThen(releaseFibers(deps.scope)))

export interface SessionManagerOptions {
  // The environment of the kernel, which a session's configuration is read with; empty when absent
  readonly env?: KernelEnv | undefined
}

// The record of running sessions starts empty with every layer, and every layer is an instance of its own
const make = (
  options: SessionManagerOptions,
): Effect.Effect<SessionManagerShape, never, SessionRequirements | Scope.Scope> =>
  Effect.gen(function* makeSessionManager() {
    const collected = yield* collectDeps
    const deps: SessionDeps = {
      ...collected,
      env: options.env ?? {},
      live: new LiveSessions(),
      instance: newInstance(),
    }
    yield* Effect.addFinalizer(() => closeAll(deps))
    return SessionManager.of({
      create: makeCreate(deps),
      prompt: makePrompt(deps),
      interrupt: makeInterrupt(deps),
      stop: makeStop(deps),
      complete: makeComplete(deps),
      resume: makeResume(deps),
      list: () => listSessions(deps.sql),
      recover: makeRecover(deps),
      get: (id) => loadSession(deps.sql, id),
    })
  })

export const SessionManagerLive = (
  options: SessionManagerOptions = {},
): Layer.Layer<SessionManager, never, SessionRequirements> =>
  Layer.effect(SessionManager, make(options))
