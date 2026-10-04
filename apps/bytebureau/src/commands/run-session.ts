import { ApiError } from '@bytebureau/client'
import { m } from '@bytebureau/i18n'
import { ProviderError, SessionError, WorkspaceError } from '@bytebureau/kernel'
import {
  decodeEventPayload,
  type Ask,
  type CreateSessionBody,
  type EventEnvelope,
} from '@bytebureau/protocol'
import type { Bureau } from '../bureau/bureau.js'
import type { Context } from '../context.js'
import { promptAsk } from '../render/ask-prompt.js'
import { completionLine, readOrSkip, summarizeRun, titleOf } from '../render/transcript.js'
import { describeError } from '../errors.js'
import { closeFrame, EXIT_REFUSED, open, refuse, report, show, type Outcome } from './run-output.js'

const EXIT_COMPLETED = 0
const EXIT_STOPPED = 3

const TERMINAL = new Set(['session.completed', 'session.stopped', 'session.errored'])

// The first of them stops the session, and one of another kind after it does nothing; the second of a kind ends the process as it would without the run
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

// Through the daemon a refusal of the kernel comes as a problem with the code the API gives its error
const REMOTE_REFUSALS = /^(?:workspace_|provider_|session_provider_missing$)/u

type Output = Context['output']

export interface RunOptions {
  readonly prompt: string
  // An absolute path: the daemon would resolve a relative one in its own working directory
  readonly project: string
  readonly branch?: string | undefined
  readonly employee?: string | undefined
  readonly provider?: string | undefined
  // The BYTEBUREAU_* variables of the command, for the agent: a daemon does not read the environment of the command
  readonly env: Readonly<Record<string, string>>
  readonly yes: boolean
}

interface Run {
  readonly bureau: Bureau
  readonly session: { readonly id: string }
  readonly options: RunOptions
  readonly context: Context
}

// Failures that end a run with exit code 4: a project, a runtime or a worktree that cannot be used, a provider that is missing or fails
export function isRefusal(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.problem !== undefined && REMOTE_REFUSALS.test(error.problem.code)
  }
  if (error instanceof WorkspaceError) {
    return true
  }
  if (error instanceof SessionError) {
    return error.code === 'provider_missing'
  }
  return error instanceof ProviderError
}

// A named provider is checked before anything is registered or created
async function unknownProvider(
  bureau: Bureau,
  provider: string | undefined,
): Promise<string | undefined> {
  if (provider === undefined) {
    return undefined
  }
  const providers = await bureau.plugins.providers()
  const available = providers.map((candidate) => candidate.id)
  return available.includes(provider)
    ? undefined
    : m.run_provider_missing({ provider, available: available.join(', ') })
}

// An ask nobody can answer is left to the kernel policy; the person is told the session waits
async function answerAsk({ bureau, options, context }: Run, ask: Ask): Promise<void> {
  const answer = await promptAsk(ask, { yes: options.yes, interactive: context.interactive })
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

// Besides showing an event the CLI answers an ask, and completes the session once its turn is over
async function react(run: Run, event: EventEnvelope): Promise<void> {
  const ask = event.type === 'ask.requested' ? askOf(event, run.context.output) : undefined
  if (ask !== undefined) {
    await answerAsk(run, ask)
  }
  if (event.type === 'turn.completed') {
    await run.bureau.sessions.complete(run.session.id)
  }
}

// The events up to the end of the session, which is the last one returned
async function follow(run: Run, events: AsyncIterable<EventEnvelope>): Promise<EventEnvelope[]> {
  const seen: EventEnvelope[] = []
  for await (const event of events) {
    seen.push(event)
    show(event, run.context)
    await react(run, event)
    if (TERMINAL.has(event.type)) {
      break
    }
  }
  return seen
}

// A stop that fails is only reported; the same signal again ends the process
async function stopSession({ bureau, session, context }: Run): Promise<void> {
  try {
    await bureau.sessions.stop(session.id)
  } catch (error) {
    context.output.warn(describeError(error))
  }
}

// Ctrl-C, SIGTERM and SIGHUP stop the session alike, once; the result is a release that removes the listeners and waits for the stop
function stopOnSignals(run: Run): () => Promise<void> {
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

// A signal stops the session; the events then say so and the run ends with the exit code of a stopped one
// The children of the kernel run detached, so the terminal does not reach them: only the stop does
async function followSession(run: Run): Promise<EventEnvelope[]> {
  const { bureau, session, options } = run
  const subscription = new AbortController()
  const release = stopOnSignals(run)
  try {
    // The ephemeral events (text deltas) carry no seq of their own and no transcript line
    const filter = { sessionId: session.id, since: 0, ephemeral: false }
    const events = bureau.events.subscribe(filter, subscription.signal)
    await bureau.sessions.prompt(session.id, { text: options.prompt })
    return await follow(run, events)
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
function outcomeOf(last: EventEnvelope, seen: readonly EventEnvelope[], output: Output): Outcome {
  switch (last.type) {
    case 'session.stopped': {
      return { code: EXIT_STOPPED, text: m.run_stopped() }
    }
    case 'session.errored': {
      return { code: EXIT_REFUSED, text: m.run_errored({ message: reasonOf(last, output) }) }
    }
    default: {
      return {
        code: EXIT_COMPLETED,
        text: output.json ? '' : completionLine(summarizeRun(seen, output)),
      }
    }
  }
}

function conclude(seen: readonly EventEnvelope[], context: Context): number {
  const last = seen.at(-1)
  if (last === undefined || !TERMINAL.has(last.type)) {
    throw new Error('the events ended before the session did')
  }
  const outcome = outcomeOf(last, seen, context.output)
  report(outcome, context)
  return outcome.code
}

// The session as the person asked for it: what is not named is left to the kernel
function sessionBody(projectId: string, options: RunOptions): CreateSessionBody {
  return {
    projectId,
    title: titleOf(options.prompt),
    ...(options.employee === undefined ? {} : { employeeId: options.employee }),
    ...(options.provider === undefined ? {} : { providerId: options.provider }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    env: options.env,
  }
}

async function startAndFollow(
  bureau: Bureau,
  options: RunOptions,
  context: Context,
): Promise<number> {
  const project = await bureau.projects.register(options.project)
  const session = await bureau.sessions.create(sessionBody(project.id, options))
  const seen = await followSession({ bureau, session, options, context })
  return conclude(seen, context)
}

// A named provider is refused before anything is registered or created
async function runOrRefuse(bureau: Bureau, options: RunOptions, context: Context): Promise<number> {
  const refusal = await unknownProvider(bureau, options.provider)
  if (refusal !== undefined) {
    return refuse(context, refusal)
  }
  const code = await startAndFollow(bureau, options, context)
  return code
}

// Streams one session to its end; the exit code is 0 completed, 3 stopped, 4 project, worktree or provider refused
// A failure that has no exit code of its own closes the frame and goes on to the runner
export async function runSession(
  bureau: Bureau,
  options: RunOptions,
  context: Context,
): Promise<number> {
  open(context, options.prompt)
  try {
    return await runOrRefuse(bureau, options, context)
  } catch (error) {
    if (!isRefusal(error)) {
      closeFrame(context)
      throw error
    }
    return refuse(context, describeError(error))
  }
}
