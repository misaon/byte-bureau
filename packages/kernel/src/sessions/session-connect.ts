import { Effect } from 'effect'
import { SessionError } from '../errors.js'
import type { Live } from './live-sessions.js'
import type { SessionDeps } from './session-deps.js'
import { requireProvider } from './session-provider.js'
import { startAgent, type StartFailure } from './session-start.js'
import type { Session } from './types.js'

// A session works in the workspace that provisioning made
const workspacePathOf = (session: Session): Effect.Effect<string, SessionError> =>
  session.workspace === null
    ? Effect.fail(
        new SessionError({ code: 'invalid_transition', reason: 'session has no workspace' }),
      )
    : Effect.succeed(session.workspace.path)

// Starts the provider session of a session; its events are not pumped yet
export const connect = (deps: SessionDeps, session: Session): Effect.Effect<Live, StartFailure> =>
  Effect.gen(function* connects() {
    const provider = yield* requireProvider(deps.host, session.providerId)
    const workspacePath = yield* workspacePathOf(session)
    const controller = new AbortController()
    const agent = yield* startAgent(deps, provider, { session, workspacePath, controller })
    return {
      session,
      workspacePath,
      agent,
      interruptible: provider.capabilities.interrupt,
      controller,
      tools: new Map(),
      pump: undefined,
      turn: null,
      interrupted: null,
      closed: false,
    }
  })
