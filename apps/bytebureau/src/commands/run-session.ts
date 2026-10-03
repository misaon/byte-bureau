import { m } from '@bytebureau/i18n'
import {
  ProviderError,
  SessionError,
  WorkspaceError,
  type CreateSessionInput,
  type EventFilter,
} from '@bytebureau/kernel'
import {
  decodeEventPayload,
  type AnsweredVia,
  type Ask,
  type AskAnswer,
  type EventEnvelope,
  type PromptInput,
} from '@bytebureau/protocol'
import { intro, log, outro } from '@clack/prompts'
import type { Context } from '../context.js'
import type { Output } from '../output.js'
import { promptAsk } from '../render/ask-prompt.js'
import {
  completionLine,
  readOrSkip,
  summarizeRun,
  titleOf,
  transcriptLine,
} from '../render/transcript.js'
import { describeError } from '../errors.js'

const EXIT_COMPLETED = 0
const EXIT_STOPPED = 3
const EXIT_PROVIDER_ERROR = 4

const TERMINAL = new Set(['session.completed', 'session.stopped', 'session.errored'])

// A project path that holds no repository to work in, or is a session worktree itself
const UNUSABLE_PROJECT = new Set(['not_a_repository', 'is_bytebureau_worktree'])

export interface RunOptions {
  readonly prompt: string
  readonly project: string
  readonly branch?: string | undefined
  readonly employee?: string | undefined
  readonly provider?: string | undefined
  readonly yes: boolean
}

// What a run needs of the kernel facade, which has more
export interface RunKernel {
  readonly providers: { readonly list: () => readonly { readonly id: string }[] }
  readonly projects: { readonly register: (path: string) => Promise<{ readonly id: string }> }
  readonly sessions: {
    readonly create: (input: CreateSessionInput) => Promise<{ readonly id: string }>
    readonly prompt: (sessionId: string, input: PromptInput) => Promise<unknown>
    readonly stop: (sessionId: string) => Promise<void>
    readonly complete: (sessionId: string) => Promise<void>
  }
  readonly asks: {
    readonly answer: (askId: string, answer: AskAnswer, via: AnsweredVia) => Promise<void>
  }
  readonly events: { readonly subscribe: (filter: EventFilter) => AsyncIterable<EventEnvelope> }
}

interface Run {
  readonly kernel: RunKernel
  readonly session: { readonly id: string }
  readonly options: RunOptions
  readonly context: Context
}

interface Outcome {
  readonly code: number
  readonly text: string
}

// Failures that end a run with exit code 4: no repository to work in, a provider that is missing or fails
function isRefusal(error: unknown): boolean {
  if (error instanceof WorkspaceError) {
    return UNUSABLE_PROJECT.has(error.code)
  }
  if (error instanceof SessionError) {
    return error.code === 'provider_missing'
  }
  return error instanceof ProviderError
}

// A terminal gets a frame: the session opens it, and every way out of the run closes it
function open({ output, interactive }: Context, prompt: string): void {
  if (interactive) {
    const title = titleOf(prompt)
    intro(output.colors.bold(m.run_intro({ title })))
  }
}

function closeFrame({ interactive }: Context): void {
  if (interactive) {
    outro()
  }
}

// A refusal ends the run with exit code 4: its text is the closing line of the frame, or goes to stderr
function refuse({ output, interactive }: Context, text: string): number {
  if (interactive) {
    outro(text)
  } else {
    output.warn(text)
  }
  return EXIT_PROVIDER_ERROR
}

// A named provider is checked before anything is registered or created
function unknownProvider(kernel: RunKernel, provider: string | undefined): string | undefined {
  const available = kernel.providers.list().map((candidate) => candidate.id)
  return provider === undefined || available.includes(provider)
    ? undefined
    : m.run_provider_missing({ provider, available: available.join(', ') })
}

// JSON output is the events themselves; text output the lines worth reading, decorated at a terminal
function show(event: EventEnvelope, { output, interactive }: Context): void {
  if (output.json) {
    output.emit(event)
    return
  }
  const line = transcriptLine(event, output)
  if (line === undefined) {
    return
  }
  if (interactive) {
    log.message(line)
  } else {
    output.print(line)
  }
}

// An ask nobody can answer is left to the kernel policy; the person is told the session waits
async function answerAsk({ kernel, options, context }: Run, ask: Ask): Promise<void> {
  const answer = await promptAsk(ask, { yes: options.yes, interactive: context.interactive })
  if (answer === undefined) {
    context.output.warn(m.run_ask_waiting({ title: ask.title }))
    return
  }
  await kernel.asks.answer(ask.id, answer, 'cli')
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
    await run.kernel.sessions.complete(run.session.id)
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

// A stop that fails is only reported; Ctrl-C again ends the process
async function stopSession({ kernel, session, context }: Run): Promise<void> {
  try {
    await kernel.sessions.stop(session.id)
  } catch (error) {
    context.output.warn(describeError(error))
  }
}

// Ctrl-C stops the session; the events then say so and the run ends with the exit code of a stopped one
// The children of the kernel run detached, so the terminal does not reach them: only the stop does
async function followSession(run: Run): Promise<EventEnvelope[]> {
  const { kernel, session, options } = run
  let stopping = Promise.resolve()
  const stop = (): void => {
    stopping = stopSession(run)
  }
  process.once('SIGINT', stop)
  try {
    // The ephemeral events (text deltas) carry no seq of their own and no transcript line
    const events = kernel.events.subscribe({ sessionId: session.id, since: 0, ephemeral: false })
    await kernel.sessions.prompt(session.id, { text: options.prompt })
    return await follow(run, events)
  } finally {
    process.off('SIGINT', stop)
    await stopping
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
      return { code: EXIT_PROVIDER_ERROR, text: m.run_errored({ message: reasonOf(last, output) }) }
    }
    default: {
      return {
        code: EXIT_COMPLETED,
        text: output.json ? '' : completionLine(summarizeRun(seen, output)),
      }
    }
  }
}

function report({ code, text }: Outcome, { output, interactive }: Context): void {
  if (interactive) {
    outro(text)
  } else if (code === EXIT_PROVIDER_ERROR) {
    output.warn(text)
  } else {
    output.print(text)
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

async function startAndFollow(
  kernel: RunKernel,
  options: RunOptions,
  context: Context,
): Promise<number> {
  const project = await kernel.projects.register(options.project)
  const session = await kernel.sessions.create({
    projectId: project.id,
    title: titleOf(options.prompt),
    employeeId: options.employee,
    providerId: options.provider,
    branch: options.branch,
  })
  const seen = await followSession({ kernel, session, options, context })
  return conclude(seen, context)
}

// A named provider is refused before anything is registered or created
async function runOrRefuse(
  kernel: RunKernel,
  options: RunOptions,
  context: Context,
): Promise<number> {
  const refusal = unknownProvider(kernel, options.provider)
  if (refusal !== undefined) {
    return refuse(context, refusal)
  }
  const code = await startAndFollow(kernel, options, context)
  return code
}

// Streams one session to its end; the exit code is 0 completed, 3 stopped, 4 project or provider refused
// A failure that has no exit code of its own closes the frame and goes on to the runner
export async function runSession(
  kernel: RunKernel,
  options: RunOptions,
  context: Context,
): Promise<number> {
  open(context, options.prompt)
  try {
    return await runOrRefuse(kernel, options, context)
  } catch (error) {
    if (!isRefusal(error)) {
      closeFrame(context)
      throw error
    }
    return refuse(context, describeError(error))
  }
}
