import type { AgentEvent, AskAnswer, AskRecord } from '@bytebureau/protocol'
import { Effect, Result } from 'effect'
import type { SessionError, StoreError } from '../errors.js'
import { reasonOf } from '../plugins/reason.js'
import type { Live } from './live-sessions.js'
import type { SessionDeps } from './session-deps.js'
import { logger } from './session-logger.js'
import { failSession, withinLimit } from './session-live.js'
import { move, moveToWaiting } from './session-status.js'

type AskRequested = Extract<AgentEvent, { readonly type: 'ask.requested' }>

// An answer and the id the agent asked with
interface Answered {
  readonly askId: string
  readonly answer: AskAnswer
}

// Runs the work only while the provider session is still the kernel's; once it is let go nothing it says counts
// The work is built when the lock is held, so what it reads of the session is what the session is
const whileOpen = <Value>(
  deps: SessionDeps,
  live: Live,
  work: () => Effect.Effect<Value, SessionError | StoreError>,
): Effect.Effect<Value | undefined, SessionError | StoreError> =>
  deps.live.exclusive(
    live.session.id,
    Effect.suspend(() => (live.closed ? Effect.undefined : work())),
  )

// The ask goes to the broker with what the session knows: how much its employee is trusted, how long to wait, where the workspace is
const open = (
  deps: SessionDeps,
  live: Live,
  event: AskRequested,
): Effect.Effect<AskRecord, StoreError> => {
  const { ask } = event
  const { employee } = live.session
  return deps.asks.open({
    sessionId: live.session.id,
    turnId: live.turn === null ? null : live.turn.turnId,
    kind: ask.kind,
    title: ask.title,
    questions: ask.questions,
    ...(ask.toolCall === undefined ? {} : { toolCall: ask.toolCall }),
    permissionMode: employee.permissionMode,
    askTimeout: employee.askTimeout ?? '30m',
    workspacePath: live.workspacePath,
    recommendationSource: ask.recommendationSource === 'agent' ? 'agent' : 'none',
  })
}

// An ask outside a running turn does not change the status of the session; it is still asked, answered and passed on
const tolerated = <Value>(
  change: Effect.Effect<Value, SessionError | StoreError>,
): Effect.Effect<void, StoreError> =>
  change.pipe(
    Effect.asVoid,
    Effect.catchTag('SessionError', (refusal) =>
      Effect.sync(() => {
        logger.warn('status not changed for an ask', { reason: refusal.reason })
      }),
    ),
  )

// The turn the kernel has asked the agent to interrupt has nothing left to ask
const isInterrupted = (live: Live): boolean =>
  live.turn !== null && live.turn.turnId === live.interrupted

// A question that comes when its turn is being interrupted is recorded and cancelled at once, and the session does not wait for it
const cancelled = (
  deps: SessionDeps,
  live: Live,
  event: AskRequested,
): Effect.Effect<AskRecord, StoreError> =>
  Effect.tap(open(deps, live, event), (record) => deps.asks.cancel(record.id))

// The session waits for a human as soon as the ask is open
const opened = (
  deps: SessionDeps,
  live: Live,
  event: AskRequested,
): Effect.Effect<AskRecord | undefined, SessionError | StoreError> =>
  whileOpen(deps, live, () =>
    isInterrupted(live)
      ? cancelled(deps, live, event)
      : Effect.tap(open(deps, live, event), (record) =>
          tolerated(moveToWaiting(deps, live.session.id, record.id)),
        ),
  )

// An ask that is cancelled, or whose service closed, has no answer to pass on
const answerOf = (deps: SessionDeps, askId: string): Effect.Effect<AskAnswer | undefined> =>
  deps.asks.await(askId).pipe(Effect.catchTag('AskError', () => Effect.undefined))

// The agent gets the answer under the id it asked with; one that cannot take it has failed
const forwarded = (
  deps: SessionDeps,
  live: Live,
  { askId, answer }: Answered,
): Effect.Effect<void, SessionError | StoreError> =>
  Effect.gen(function* forwardsAnswer() {
    const sent = yield* Effect.result(
      withinLimit(
        Effect.tryPromise({
          try: async () => {
            await live.agent.answer(askId, answer)
          },
          catch: reasonOf,
        }),
      ),
    )
    if (Result.isFailure(sent)) {
      const message = `the agent did not take the answer: ${reasonOf(sent.failure)}`
      yield* failSession(deps, live, { kind: 'protocol', message, retryable: false })
    } else {
      yield* tolerated(move(deps, live.session.id, 'answer'))
    }
  })

// The provider waits for its answer, so the pump waits as well, and nobody else's change is held up meanwhile
// The lock is taken to open the ask and to pass the answer on, and not in between
export const handleAsk = (
  deps: SessionDeps,
  live: Live,
  event: AskRequested,
): Effect.Effect<void, SessionError | StoreError> =>
  Effect.gen(function* handlesAsk() {
    const record = yield* opened(deps, live, event)
    if (record === undefined) {
      return
    }
    const answer = yield* answerOf(deps, record.id)
    if (answer !== undefined) {
      yield* whileOpen(deps, live, () => forwarded(deps, live, { askId: event.ask.id, answer }))
    }
  })
