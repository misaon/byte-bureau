import type { PromptInput } from '@bytebureau/protocol'
import { Effect } from 'effect'
import { constVoid } from 'effect/Function'
import { reasonOf } from '../plugins/reason.js'
import type { Live } from './live-sessions.js'
import type { SessionDeps } from './session-deps.js'
import { failSession, reported } from './session-live.js'

// A prompt the agent does not take is a crash of the agent, which nobody is waiting to hear about
const failedPrompt = (deps: SessionDeps, live: Live, reason: string): Effect.Effect<void> =>
  deps.live
    .exclusive(
      live.session.id,
      Effect.suspend(() =>
        live.closed
          ? Effect.void
          : failSession(deps, live, {
              kind: 'crash',
              message: `the agent did not take the prompt: ${reason}`,
              retryable: true,
            }),
      ),
    )
    .pipe(reported({ sessionId: live.session.id, event: 'prompt' }))

// The prompt goes to the agent on a fiber of its own: the agent may answer it only when the turn is over
export const sendPrompt = (
  deps: SessionDeps,
  live: Live,
  input: PromptInput,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      await live.agent.prompt(input)
    },
    catch: reasonOf,
  }).pipe(
    Effect.matchEffect({
      onFailure: (reason) => failedPrompt(deps, live, reason),
      onSuccess: () => Effect.sync(constVoid),
    }),
  )
