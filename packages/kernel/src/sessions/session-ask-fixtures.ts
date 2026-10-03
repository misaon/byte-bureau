import type { AgentEvent, Ask, AskRecord } from '@bytebureau/protocol'
import { Effect, Stream, type Cause, type Fiber } from 'effect'
import { AskService } from '../asks/ask-service.js'
import type { AskError, StoreError } from '../errors.js'
import { EventLog } from '../events/event-log.js'
import type { ScriptedSession } from '../testing/scripted-provider.js'
import { waitFor } from './session-fixtures.js'
import { workspaceOf } from './session-helpers.js'
import type { Session } from './types.js'

type Waiting = Effect.Effect<
  AskRecord,
  StoreError | Cause.NoSuchElementError,
  AskService | EventLog
>

// The ask a session has pending, once the event that tells of it has been published
// A session that waits for a human says so with session.waiting, which an ask outside a running turn does not
export const pendingAsk = (sessionId: string, announced = 'session.waiting'): Waiting =>
  Effect.gen(function* findsPending() {
    yield* waitFor(sessionId, announced)
    const asks = yield* AskService
    const [ask] = yield* asks.pending(sessionId)
    return yield* Effect.fromNullishOr(ask)
  })

// Answers the ask a session waits on, and tells which ask it was
export const answerPending = (
  sessionId: string,
  selected: readonly string[],
  announced = 'session.waiting',
): Effect.Effect<
  AskRecord,
  AskError | StoreError | Cause.NoSuchElementError,
  AskService | EventLog
> =>
  Effect.gen(function* answersPending() {
    const pending = yield* pendingAsk(sessionId, announced)
    const asks = yield* AskService
    yield* asks.answer(pending.id, { selected }, 'cli')
    return pending
  })

interface Collected {
  readonly type: string
  readonly seq: number
  readonly payload: unknown
}

// Collects what a session publishes up to its completion, from the first event on
export const collectUntilCompleted = (
  sessionId: string,
): Effect.Effect<Fiber.Fiber<readonly Collected[], StoreError>, never, EventLog> =>
  Effect.gen(function* collects() {
    const log = yield* EventLog
    const events = log.subscribe({ sessionId, since: 0 }).pipe(
      Stream.takeUntil((event) => event.type === 'session.completed'),
      Stream.runCollect,
    )
    return yield* Effect.forkChild(events)
  })

// What an agent asks to write a file: the permission is judged by where the file is
const writeAsk = (target: string): Ask => ({
  id: 'provider-ask-1',
  sessionId: 'ignored',
  turnId: null,
  kind: 'permission',
  title: 'Write',
  questions: [],
  toolCall: { name: 'Write', input: { file_path: target } },
  policy: { onTimeout: 'wait', timeout: '30m' },
  recommendationSource: 'none',
  status: 'pending',
  createdAt: '2026-10-03T00:00:00.000Z',
  deadlineAt: null,
})

// The event of an agent that asks to write a file in the workspace of the session
export const writeRequest = (session: Session): AgentEvent => ({
  type: 'ask.requested',
  ask: writeAsk(`${workspaceOf(session)}/src/a.ts`),
})

// The agent asks to write a file in the workspace of the session, and the session waits for a human
export const askToWrite = (session: Session, agent: ScriptedSession): Waiting => {
  agent.queue.push(writeRequest(session))
  return pendingAsk(session.id)
}

// A question with one option the agent recommends
const recommendedQuestion: Ask = {
  id: 'agent-ask',
  sessionId: 'ignored',
  turnId: null,
  kind: 'question',
  title: 'Which?',
  questions: [
    {
      id: 'q',
      header: 'Which',
      prompt: 'Which?',
      multiSelect: false,
      allowOther: false,
      options: [{ id: 'a', label: 'A', recommended: true, evidence: [] }],
    },
  ],
  policy: { onTimeout: 'wait', timeout: '30m' },
  recommendationSource: 'agent',
  status: 'pending',
  createdAt: '2026-10-03T00:00:00.000Z',
  deadlineAt: null,
}

// The event of an agent that asks a question and recommends its answer
export const questionRequest: AgentEvent = { type: 'ask.requested', ask: recommendedQuestion }
