import type { PromptInput } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { Live } from './live-sessions.js'
import { attach } from './session-agent.js'
import type { SessionDeps } from './session-deps.js'
import { requireSession } from './session-records.js'
import { sendPrompt } from './session-send.js'
import type { SessionManagerShape } from './session-shape.js'
import { ensureAllowed, moveAndClaim } from './session-status.js'
import { startTurn } from './session-turns.js'

// The turn is recorded and announced, and its worktree is locked until it is over
const begin = (deps: SessionDeps, live: Live, input: PromptInput): ReturnType<typeof startTurn> =>
  Effect.gen(function* beginsTurn() {
    const turn = yield* startTurn(deps, live.session, input)
    live.turn = { turnId: turn.id, index: turn.index }
    yield* deps.workspaces.lock(live.session.id)
    return turn
  })

// The refusals come first: a session that cannot take a prompt gets no provider session
// The plugins may change the text on its way to the agent, not what is recorded and announced
// The agent has the prompt in hand when this returns, so an interruption that follows cannot overtake it
export const makePrompt =
  (deps: SessionDeps): SessionManagerShape['prompt'] =>
  (sessionId, input) =>
    deps.live.exclusive(
      sessionId,
      Effect.gen(function* promptsSession() {
        const session = yield* requireSession(deps.sql, sessionId)
        yield* ensureAllowed(session, 'prompt')
        const live = yield* attach(deps, session)
        yield* moveAndClaim(deps, sessionId, 'prompt')
        const turn = yield* begin(deps, live, input)
        const hook = { sessionId, input }
        const sent = yield* deps.host.hooks.run('prompt.beforeSend', hook, Effect.succeed)
        const sending = sendPrompt(deps, live, sent.input)
        yield* Effect.forkIn(sending, deps.scope, { startImmediately: true })
        return turn
      }),
    )
