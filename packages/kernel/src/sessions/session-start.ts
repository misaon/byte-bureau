import {
  ProviderConfigError,
  type AgentProvider,
  type AgentSession,
  type CreateSessionRequest,
} from '@bytebureau/plugin-api'
import { Effect } from 'effect'
import {
  ConfigError,
  ProviderError,
  type ProfileError,
  type SessionError,
  type StoreError,
} from '../errors.js'
import { kernelLogger } from '../logging/logging.js'
import { reasonOf } from '../plugins/reason.js'
import { allowlistEnv, bytebureauEnv } from '../process/env-allowlist.js'
import type { SessionDeps } from './session-deps.js'
import { attempt } from './session-live.js'
import { profilePartOf, providerSetupOf } from './session-setup.js'
import type { Session } from './types.js'

// What the start of a provider session is made of: the signal of its controller is the one the provider gets
export interface Start {
  readonly session: Session
  readonly workspacePath: string
  readonly controller: AbortController
}

// What can keep a provider session from starting
export type StartFailure = ProviderError | SessionError | ConfigError | StoreError

// A profile the session cannot run under refuses the start as the provider would refuse a login
const authRefusal = (refused: ProfileError): ProviderError =>
  new ProviderError({ kind: 'auth', reason: refused.reason, retryable: false })

// The request, and the project file a configuration error of the provider is told against
interface Prepared {
  readonly request: CreateSessionRequest
  readonly configFile: string
}

// The agent gets the environment of the kernel through the allowlist, widened by the passEnv names of its provider, the names of ByteBureau among the extra variables given at creation, the key of its profile and the id of its session
const requestOf = (
  deps: SessionDeps,
  { session, workspacePath, controller }: Start,
): Effect.Effect<Prepared, StartFailure> =>
  Effect.gen(function* buildsRequest() {
    const part = yield* profilePartOf(deps, session).pipe(
      Effect.catchTag('ProfileError', (refused) => Effect.fail(authRefusal(refused))),
    )
    const { providerConfig, trust, configFile } = yield* providerSetupOf(deps, session)
    const { extra, passEnv } = deps.live.environmentOf(session.id)
    const request = {
      sessionId: session.id,
      workspace: { path: workspacePath },
      employee: session.employee,
      profile: part.profile,
      providerConfig,
      trust,
      ...(session.externalRef === null ? {} : { resume: session.externalRef }),
      env: {
        ...allowlistEnv(process.env, passEnv),
        ...bytebureauEnv(extra),
        ...part.env,
        BYTEBUREAU_SESSION_ID: session.id,
      },
      signal: controller.signal,
      logger: kernelLogger(['bb', 'agent', session.providerId]),
    }
    return { request, configFile }
  })

// A provider that has not started a session within this time is given up on, so it cannot hold a session for ever
export const START_LIMIT = '60 seconds'

// The error of a section the adapter cannot use, by its class, or by its name where a plugin brings a copy of the plugin-api of its own
const configReasonOf = (cause: unknown): string | undefined => {
  if (cause instanceof ProviderConfigError) {
    return cause.reason
  }
  if (!(cause instanceof Error) || cause.name !== 'ProviderConfigError') {
    return undefined
  }
  const reason: unknown = Reflect.get(cause, 'reason')
  return typeof reason === 'string' ? reason : cause.message
}

// A provider section the adapter cannot use is the project's configuration error, never a crash of an agent that did not run
const startFailure =
  (configFile: string) =>
  (cause: unknown): ProviderError | ConfigError => {
    const reason = configReasonOf(cause)
    return reason === undefined
      ? new ProviderError({ kind: 'crash', reason: reasonOf(cause), retryable: true })
      : new ConfigError({ file: configFile, pointer: '', reason })
  }

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

// The request is made before the start is timed: the provider's start alone is bounded
// The start and what calls it off are set up in one step, so an interruption cannot fall between them; only the wait can be interrupted
export const startAgent = (
  deps: SessionDeps,
  provider: AgentProvider,
  start: Start,
): Effect.Effect<AgentSession, StartFailure> =>
  Effect.flatMap(requestOf(deps, start), ({ request, configFile }) =>
    Effect.uninterruptibleMask((restore) => {
      const starting = begin(provider, request)
      const awaited = Effect.tryPromise({
        try: async () => {
          const agent = await starting
          return agent
        },
        catch: (cause) => cause,
      })
      return restore(Effect.timeout(awaited, START_LIMIT)).pipe(
        Effect.onError(() => abandon(deps, starting, start)),
        Effect.mapError(startFailure(configFile)),
      )
    }),
  )
