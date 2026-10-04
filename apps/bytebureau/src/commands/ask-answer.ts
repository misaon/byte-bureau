import type { AskAnswer, AskRecord } from '@bytebureau/protocol'
import type { Context } from '../context.js'
import { promptAsk } from '../render/ask-prompt.js'

// What the flags of `ask answer` say, and whether --yes is among them
export interface AnswerFlags {
  readonly options: readonly string[]
  readonly other: string | undefined
  readonly yes: boolean
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

// The answer the flags spell; none means the person is asked, which only a terminal can do
export async function answerOf(
  { options, other, yes }: AnswerFlags,
  ask: AskRecord,
  context: Context,
): Promise<AskAnswer | undefined> {
  if (other !== undefined && other !== '') {
    return { selected: 'other', otherText: other }
  }
  if (options.length > 0) {
    return { selected: [...options] }
  }
  const answer = await promptAsk(ask, { yes, interactive: context.interactive })
  return answer
}
