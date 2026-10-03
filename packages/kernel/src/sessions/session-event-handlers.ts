import type { AgentEvent } from '@bytebureau/protocol'
import { Effect } from 'effect'
import type { SessionError, StoreError } from '../errors.js'
import type { Live } from './live-sessions.js'
import { announce, turnIdOf } from './session-announce.js'
import type { SessionDeps } from './session-deps.js'
import { rememberRef } from './session-live.js'
import { move } from './session-status.js'
import { endTool, startTool } from './session-tools.js'
import { finishTurn, insertMessage } from './session-turns.js'

export type Handled<Type extends AgentEvent['type']> = Extract<AgentEvent, { readonly type: Type }>

export type HandlerFailure = SessionError | StoreError

export const toolStarted = (
  deps: SessionDeps,
  live: Live,
  event: Handled<'tool.started'>,
): Effect.Effect<void, StoreError> =>
  Effect.andThen(startTool(deps.sql, live, event), () => announce(deps, live, event))

// The call is closed in the record first and told of after; its note is let go once it has been told
export const toolEnded = (
  deps: SessionDeps,
  live: Live,
  event: Handled<'tool.completed' | 'tool.failed'>,
): Effect.Effect<void, StoreError> =>
  Effect.andThen(endTool(deps.sql, live, event), () => announce(deps, live, event)).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        live.tools.delete(event.id)
      }),
    ),
  )

// Only what the assistant says is kept as a message of the session; the user's came with the prompt
export const messageCompleted = (
  deps: SessionDeps,
  live: Live,
  event: Handled<'message.completed'>,
): Effect.Effect<void, StoreError> =>
  Effect.gen(function* completesMessage() {
    if (event.role === 'assistant') {
      const message = { sessionId: live.session.id, turnId: turnIdOf(live), role: event.role }
      yield* insertMessage(deps.sql, { ...message, content: event.content })
    }
    yield* announce(deps, live, event)
  })

export const rateLimited = (
  deps: SessionDeps,
  live: Live,
  event: Handled<'ratelimit.updated'>,
): Effect.Effect<void, StoreError> =>
  Effect.andThen(deps.usage.record(live.session.profileId, event.rateLimit), () =>
    announce(deps, live, event),
  )

// The turn ends with its usage and the worktree is free again before the session is ready for the next prompt
// A completion that comes when no turn is running ends nothing and changes no status
// The reference of the provider session is kept last: failing to save it must not keep the session from being ready
export const turnCompleted = (
  deps: SessionDeps,
  live: Live,
  event: Handled<'turn.completed'>,
): Effect.Effect<void, HandlerFailure> =>
  Effect.gen(function* completesTurn() {
    const status = event.stopReason === 'interrupted' ? 'interrupted' : 'completed'
    const outcome = { status, stopReason: event.stopReason, usage: event.usage } as const
    const finished = yield* finishTurn(deps, live.session, outcome)
    live.turn = null
    yield* deps.workspaces.unlock(live.session.id)
    if (finished !== undefined) {
      yield* move(deps, live.session.id, 'turn_done')
    }
    yield* rememberRef(deps, live)
  })
