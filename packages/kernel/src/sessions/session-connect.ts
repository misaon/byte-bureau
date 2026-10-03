import type { AgentProvider, AgentSession, CreateSessionRequest } from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import { ProviderError, SessionError } from '../errors.js'
import { kernelLogger } from '../logging/logging.js'
import { reasonOf } from '../plugins/reason.js'
import { allowlistEnv } from '../process/env-allowlist.js'
import type { Live } from './live-sessions.js'
import type { SessionDeps } from './session-deps.js'
import { requireProvider } from './session-provider.js'
import type { Session } from './types.js'

interface Start {
  readonly session: Session
  readonly workspacePath: string
  readonly controller: AbortController
}

// The agent gets the environment of the kernel through the allowlist, the extra variables given at creation through it as well, and the id of its session
const requestOf = (
  deps: SessionDeps,
  { session, workspacePath, controller }: Start,
): CreateSessionRequest => ({
  sessionId: session.id,
  workspace: { path: workspacePath },
  employee: session.employee,
  profile: { id: session.profileId ?? 'default', providerId: session.providerId, kind: 'login' },
  ...(session.externalRef === null ? {} : { resume: session.externalRef }),
  env: {
    ...allowlistEnv(process.env),
    ...allowlistEnv(deps.live.environmentOf(session.id)),
    BYTEBUREAU_SESSION_ID: session.id,
  },
  signal: controller.signal,
  logger: kernelLogger(['bb', 'agent', session.providerId]),
})

// A provider that has not started a session within this time is given up on, so it cannot hold a session for ever
const START_LIMIT = '60 seconds'

const startFailure = (cause: unknown): ProviderError =>
  new ProviderError({ kind: 'crash', reason: reasonOf(cause), retryable: true })

const startAgent = (
  provider: AgentProvider,
  request: CreateSessionRequest,
): Effect.Effect<AgentSession, ProviderError> =>
  Effect.tryPromise({
    try: async () => {
      const agent = await provider.createSession(request)
      return agent
    },
    catch: (cause) => cause,
  }).pipe(Effect.timeout(START_LIMIT), Effect.mapError(startFailure))

// A session works in the workspace that provisioning made
const workspacePathOf = (session: Session): Effect.Effect<string, SessionError> =>
  session.workspace === null
    ? Effect.fail(
        new SessionError({ code: 'invalid_transition', reason: 'session has no workspace' }),
      )
    : Effect.succeed(session.workspace.path)

// Starts the provider session of a session; its events are not pumped yet
export const connect = (
  deps: SessionDeps,
  session: Session,
): Effect.Effect<Live, SessionError | ProviderError> =>
  Effect.gen(function* connects() {
    const provider = yield* requireProvider(deps.host, session.providerId)
    const workspacePath = yield* workspacePathOf(session)
    const controller = new AbortController()
    const agent = yield* startAgent(
      provider,
      requestOf(deps, { session, workspacePath, controller }),
    )
    return {
      session,
      workspacePath,
      agent,
      controller,
      tools: new Map(),
      pump: undefined,
      turn: null,
      closed: false,
    }
  })
