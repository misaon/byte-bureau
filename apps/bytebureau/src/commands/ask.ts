import { m } from '@bytebureau/i18n'
import type { AskAnswer, AskRecord } from '@bytebureau/protocol'
import { defineCommand } from 'citty'
import type { Bureau } from '../bureau/bureau.js'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'
import { askRows } from '../render/rows.js'
import { table } from '../render/tables.js'
import { answerOf, optionsOf, type AnswerFlags } from './ask-answer.js'
import { withBureauRefusable } from './refusable.js'

function tellAsks(context: Context, asks: readonly AskRecord[]): void {
  context.output.emit({ command: 'ask.ls', asks })
  if (asks.length === 0) {
    context.output.print(m.ask_none())
    return
  }
  for (const line of table(askRows(asks))) {
    context.output.print(line)
  }
}

const ls = defineCommand({
  meta: { name: 'ls', description: 'List the asks waiting for an answer' },
  args: {
    ...globalArgs,
    session: { type: 'string', description: 'Only the asks of this session' },
  },
  async run({ args }) {
    const context = processContext(args)
    const asks = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const pending = await bureau.asks.pending(args.session)
      return pending
    })
    if (asks !== undefined) {
      tellAsks(context, asks)
    }
  },
})

// The command ends with exit code 1 and the words that say why
function failWith(context: Context, text: string): void {
  context.output.warn(text)
  process.exitCode = 1
}

function tellAnswered(context: Context, id: string, answer: AskAnswer): void {
  context.output.emit({ command: 'ask.answer', id, answer })
  context.output.print(m.ask_answered({ id }))
}

interface Answering {
  readonly id: string
  readonly flags: AnswerFlags
}

// The ask must be pending, and the flags, or the person at a terminal, must answer it
async function answerAsk(
  bureau: Bureau,
  { id, flags }: Answering,
  context: Context,
): Promise<void> {
  const ask = await bureau.asks.get(id)
  if (ask === undefined || ask.status !== 'pending') {
    failWith(context, m.ask_not_pending({ id }))
    return
  }
  const answer = await answerOf(flags, ask, context)
  if (answer === undefined) {
    failWith(context, m.ask_needs_answer({ id }))
    return
  }
  await bureau.asks.answer(id, answer)
  tellAnswered(context, id, answer)
}

const answer = defineCommand({
  meta: { name: 'answer', description: 'Answer an ask by id' },
  args: {
    ...globalArgs,
    id: { type: 'positional', description: 'Ask id', required: true },
    option: {
      type: 'string',
      description: 'Option id to select; once for each question of the ask',
    },
    other: { type: 'string', description: 'Free-text answer when the ask allows it' },
  },
  async run({ args, rawArgs }) {
    const context = processContext(args)
    const flags = { options: optionsOf(rawArgs), other: args.other, yes: args.yes }
    await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      await answerAsk(bureau, { id: args.id, flags }, context)
    })
  },
})

export const askCommand = defineCommand({
  meta: { name: 'ask', description: 'List and answer asks' },
  subCommands: { ls, answer },
})
