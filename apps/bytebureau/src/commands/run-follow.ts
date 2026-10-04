import { m } from '@bytebureau/i18n'
import { decodeEventPayload, type Ask, type EventEnvelope } from '@bytebureau/protocol'
import type { Bureau } from '../bureau/bureau.js'
import type { Context } from '../context.js'
import { describeError } from '../errors.js'
import { promptAsk } from '../render/ask-prompt.js'
import { completionLine, readOrSkip, summarizeRun } from '../render/transcript.js'
import { EXIT_REFUSED, report, show, type Outcome } from './run-output.js'

const EXIT_COMPLETED = 0
const EXIT_STOPPED = 3

// The event of a session that is ready again: it ends the follow of a turn that was interrupted, when no stop or error comes
const READY = 'session.ready'

// The first of them stops the session, and one of another kind after it does nothing; the second of a kind ends the process as it would without the run
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

type Output = Context['output']

// How a follow ends, and what it follows
export interface Ends {
  // The types of the events that end it; a turn that was interrupted ends where the session next says what became of it
  readonly terminal: ReadonlySet<string>
  // Whether the end of the turn completes the session: a run is one turn, a prompt leaves the session ready for the next
  readonly completes: boolean
  // Whether the events of the turn the prompt begins are all it follows: a session that has had turns before has their events too
  readonly turnOnly: boolean
}

// What follows a session: the Bureau it asks, the person it asks for an answer, and how it ends
export interface Following {
  readonly bureau: Bureau
  readonly session: { readonly id: string }
  readonly context: Context
  readonly yes: boolean
  readonly ends: Ends
}

// The events shown, and the one that ended the follow; none when the events ran out first
export interface Followed {
  readonly seen: readonly EventEnvelope[]
  readonly end: EventEnvelope | undefined
}

// An ask nobody can answer is left to the kernel policy; the person is told the session waits
async function answerAsk({ bureau, yes, context }: Following, ask: Ask): Promise<void> {
  const answer = await promptAsk(ask, { yes, interactive: context.interactive })
  if (answer === undefined) {
    context.output.warn(m.run_ask_waiting({ title: ask.title }))
    return
  }
  await bureau.asks.answer(ask.id, answer)
}

// The ask of an ask.requested event, if its payload fits
function askOf(event: EventEnvelope, output: Output): Ask | undefined {
  return readOrSkip(event, output, () => decodeEventPayload('ask.requested', event.payload).ask)
}

// Besides showing an event the CLI answers an ask, and completes the session once its turn is over, where that is its end
async function react(run: Following, event: EventEnvelope): Promise<void> {
  const ask = event.type === 'ask.requested' ? askOf(event, run.context.output) : undefined
  if (ask !== undefined) {
    await answerAsk(run, ask)
  }
  if (event.type === 'turn.completed' && run.ends.completes) {
    await run.bureau.sessions.complete(run.session.id)
  }
}

// An interrupted turn is no end by itself: the session says next what became of it, ready again, stopped or errored
// Whoever interrupted the turn or stopped the session, this process by a signal or another command, the events tell the same
function isEnd({ ends }: Following, event: EventEnvelope, interrupted: boolean): boolean {
  return ends.terminal.has(event.type) || (interrupted && event.type === READY)
}

// The events up to the end of the follow, which is the last one shown
async function follow(run: Following, events: AsyncIterable<EventEnvelope>): Promise<Followed> {
  const seen: EventEnvelope[] = []
  let interrupted = false
  for await (const event of events) {
    seen.push(event)
    show(event, run.context)
    await react(run, event)
    interrupted ||= event.type === 'turn.interrupted'
    if (isEnd(run, event, interrupted)) {
      return { seen, end: event }
    }
  }
  return { seen, end: undefined }
}

// A stop that fails is only reported; the same signal again ends the process
async function stopSession({ bureau, session, context }: Following): Promise<void> {
  try {
    await bureau.sessions.stop(session.id)
  } catch (error) {
    context.output.warn(describeError(error))
  }
}

// Ctrl-C, SIGTERM and SIGHUP stop the session alike, once; the result is a release that removes the listeners and waits for the stop
function stopOnSignals(run: Following): () => Promise<void> {
  let stopping = Promise.resolve()
  let stopped = false
  const stop = (): void => {
    if (!stopped) {
      stopped = true
      stopping = stopSession(run)
    }
  }
  for (const signal of STOP_SIGNALS) {
    process.once(signal, stop)
  }
  return async () => {
    for (const signal of STOP_SIGNALS) {
      process.off(signal, stop)
    }
    await stopping
  }
}

// The events of one turn: those it owns, and those of the session that end a follow, which no turn owns
// A stop or an error from before the turn began is no end of it, so the session's events count only once it has
async function* ofTurn(
  events: AsyncIterable<EventEnvelope>,
  turnId: string,
  terminal: ReadonlySet<string>,
): AsyncGenerator<EventEnvelope> {
  let begun = false
  for await (const event of events) {
    const owned = event.turnId === turnId
    begun ||= owned
    const sessionEnd = terminal.has(event.type) || event.type === READY
    if (owned || (begun && event.turnId === undefined && sessionEnd)) {
      yield event
    }
  }
}

// Prompts the session and follows its events to the end of the follow
// A signal stops the session; the events then say so and the follow ends with the exit code of a stopped one
// The children of the kernel run detached, so the terminal does not reach them: only the stop does
export async function promptAndFollow(run: Following, text: string): Promise<Followed> {
  const { bureau, session, ends } = run
  const subscription = new AbortController()
  const release = stopOnSignals(run)
  try {
    // The ephemeral events (text deltas) carry no seq of their own and no transcript line
    const filter = { sessionId: session.id, since: 0, ephemeral: false }
    const events = bureau.events.subscribe(filter, subscription.signal)
    const turn = await bureau.sessions.prompt(session.id, { text })
    return await follow(run, ends.turnOnly ? ofTurn(events, turn.id, ends.terminal) : events)
  } finally {
    subscription.abort()
    await release()
  }
}

// The reason of an errored session; the type of the event stands in for a payload that cannot be read
function reasonOf(last: EventEnvelope, output: Output): string {
  const reason = readOrSkip(last, output, () => decodeEventPayload('session.errored', last.payload))
  return reason === undefined ? last.type : reason.message
}

// The summary is built only for the words that are printed: JSON output has none
function outcomeOf(end: EventEnvelope, seen: readonly EventEnvelope[], output: Output): Outcome {
  switch (end.type) {
    case 'session.stopped': {
      return { code: EXIT_STOPPED, text: m.run_stopped() }
    }
    case READY: {
      return { code: EXIT_STOPPED, text: m.run_interrupted() }
    }
    case 'session.errored': {
      return { code: EXIT_REFUSED, text: m.run_errored({ message: reasonOf(end, output) }) }
    }
    default: {
      return {
        code: EXIT_COMPLETED,
        text: output.json ? '' : completionLine(summarizeRun(seen, output)),
      }
    }
  }
}

export function conclude({ seen, end }: Followed, context: Context): number {
  if (end === undefined) {
    throw new Error('the events ended before the session did')
  }
  const outcome = outcomeOf(end, seen, context.output)
  report(outcome, context)
  return outcome.code
}
