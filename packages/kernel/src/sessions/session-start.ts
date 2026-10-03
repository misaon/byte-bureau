import type { AgentProvider, AgentSession, CreateSessionRequest } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import { ProviderError } from '../errors.js'
import { kernelLogger } from '../logging/logging.js'
import { reasonOf } from '../plugins/reason.js'
import { allowlistEnv, bytebureauEnv } from '../process/env-allowlist.js'
import type { SessionDeps } from './session-deps.js'
import { attempt } from './session-live.js'
import type { Session } from './types.js'

// What the start of a provider session is made of: the signal of its controller is the one the provider gets
export interface Start {
  readonly session: Session
  readonly workspacePath: string
  readonly controller: AbortController
}

// The agent gets the environment of the kernel through the allowlist, widened by the passEnv names of its provider, the names of ByteBureau among the extra variables given at creation, and the id of its session
const requestOf = (
  deps: SessionDeps,
  { session, workspacePath, controller }: Start,
): CreateSessionRequest => {
  const { extra, passEnv } = deps.live.environmentOf(session.id)
  return {
    sessionId: session.id,
    workspace: { path: workspacePath },
    employee: session.employee,
    profile: { id: session.profileId ?? 'default', providerId: session.providerId, kind: 'login' },
    ...(session.externalRef === null ? {} : { resume: session.externalRef }),
    env: {
      ...allowlistEnv(process.env, passEnv),
      ...bytebureauEnv(extra),
      BYTEBUREAU_SESSION_ID: session.id,
    },
    signal: controller.signal,
    logger: kernelLogger(['bb', 'agent', session.providerId]),
  }
}

// A provider that has not started a session within this time is given up on, so it cannot hold a session for ever
export const START_LIMIT = '60 seconds'

const startFailure = (cause: unknown): ProviderError =>
  new ProviderError({ kind: 'crash', reason: reasonOf(cause), retryable: true })

// The start is a promise of its own, so what is left of it can still be dealt with when the kernel has given up on it
const begin = async (
  provider: AgentProvider,
  request: CreateSessionRequest,
): Promise<AgentSession> => {
  const agent = await provider.createSession(request)
  return agent
}

// The session of a start that was given up on, if it still comes, is nobody's, so it is closed
// A start that fails has nothing to close
const closeLate = (starting: Promise<AgentSession>, sessionId: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      const agent = await starting
      return agent
    },
    catch: reasonOf,
  }).pipe(
    Effect.flatMap((agent) =>
      attempt('closing a session that started late', sessionId, async () => {
        await agent.close()
      }),
    ),
    Effect.ignore,
  )

// A start that is given up on, by its time or its caller, is called off: its signal is aborted and the session it may still give is closed
const abandon = (
  deps: SessionDeps,
  starting: Promise<AgentSession>,
  { session, controller }: Start,
): Effect.Effect<void> => {
  const closing = closeLate(starting, session.id)
  return Effect.sync(() => {
    controller.abort()
  }).pipe(
    Effect.andThen(Effect.forkIn(closing, deps.scope, { startImmediately: true })),
    Effect.asVoid,
  )
}

export const startAgent = (
  deps: SessionDeps,
  provider: AgentProvider,
  start: Start,
): Effect.Effect<AgentSession, ProviderError> =>
  Effect.suspend(() => {
    const starting = begin(provider, requestOf(deps, start))
    return Effect.tryPromise({
      try: async () => {
        const agent = await starting
        return agent
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.timeout(START_LIMIT),
      Effect.onError(() => abandon(deps, starting, start)),
      Effect.mapError(startFailure),
    )
  })
