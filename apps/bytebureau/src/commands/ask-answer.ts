import { m } from '@bytebureau/i18n'
import type { AskAnswer, AskRecord } from '@bytebureau/protocol'
import type { Bureau } from '../bureau/bureau.js'
import type { Context } from '../context.js'
import { promptAsk, type Prompts } from '../render/ask-prompt.js'

// What the flags of `ask answer` say, and whether --yes is among them
export interface AnswerFlags {
  readonly options: readonly string[]
  readonly other: string | undefined
  readonly yes: boolean
  // The prompts a person answers through; a test can put others in place of the terminal's
  readonly prompts?: Prompts | undefined
}

export interface Answering extends AnswerFlags {
  readonly id: string
}

// An ask with several questions is answered with one --option for each, but citty keeps only the last of a flag that is given twice
// So the ids are read from the arguments themselves
export function optionsOf(rawArgs: readonly string[]): string[] {
  const options: string[] = []
  for (const [index, arg] of rawArgs.entries()) {
    if (arg === '--') {
      break
    }
    if (arg === '--option') {
      const next = rawArgs[index + 1]
      if (next !== undefined) {
        options.push(next)
      }
    } else if (arg.startsWith('--option=')) {
      options.push(arg.slice('--option='.length))
    }
  }
  return options
}

// The answer the flags spell; else the person at a terminal is asked
// A person who was asked and gave no answer cancelled the prompt; none means nobody could be asked
export async function answerOf(
  { options, other, yes, prompts }: AnswerFlags,
  ask: AskRecord,
  context: Context,
): Promise<AskAnswer | 'cancelled' | undefined> {
  if (other !== undefined && other !== '') {
    return { selected: 'other', otherText: other }
  }
  if (options.length > 0) {
    return { selected: [...options] }
  }
  const answer = await promptAsk(ask, { yes, interactive: context.interactive }, prompts)
  return answer === undefined && !yes && context.interactive ? 'cancelled' : answer
}

// The command ends with exit code 1 and the words that say why
function failWith(context: Context, text: string): void {
  context.output.warn(text)
  process.exitCode = 1
}

// The ask of the id, if it still waits for an answer
async function pendingAsk(
  bureau: Bureau,
  id: string,
  context: Context,
): Promise<AskRecord | undefined> {
  const ask = await bureau.asks.get(id)
  if (ask === undefined || ask.status !== 'pending') {
    failWith(context, m.ask_not_pending({ id }))
    return undefined
  }
  return ask
}

// A cancelled prompt ends the command with exit code 1 and no line: the prompt has shown that it was cancelled
async function answerFor(
  request: Answering,
  ask: AskRecord,
  context: Context,
): Promise<AskAnswer | undefined> {
  const said = await answerOf(request, ask, context)
  if (said === 'cancelled') {
    process.exitCode = 1
    return undefined
  }
  if (said === undefined) {
    // --yes asked for the recommended option, and there is none: the person is not left to wonder about a terminal
    failWith(
      context,
      request.yes
        ? m.ask_no_recommended({ id: request.id })
        : m.ask_needs_answer({ id: request.id }),
    )
  }
  return said
}

// The ask must be pending, and the flags, or the person at a terminal, must answer it
export async function answerAsk(
  bureau: Bureau,
  request: Answering,
  context: Context,
): Promise<void> {
  const ask = await pendingAsk(bureau, request.id, context)
  if (ask === undefined) {
    return
  }
  const answer = await answerFor(request, ask, context)
  if (answer !== undefined) {
    await bureau.asks.answer(ask.id, answer)
    context.output.emit({ command: 'ask.answer', id: ask.id, answer })
    context.output.print(m.ask_answered({ id: ask.id }))
  }
}
