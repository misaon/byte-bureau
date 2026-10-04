import { m } from '@bytebureau/i18n'
import type { AskRecord } from '@bytebureau/protocol'
import { defineCommand } from 'citty'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'
import { askRows } from '../render/rows.js'
import { table } from '../render/tables.js'
import { answerAsk, optionsOf } from './ask-answer.js'
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
    const request = { id: args.id, options: optionsOf(rawArgs), other: args.other, yes: args.yes }
    await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      await answerAsk(bureau, request, context)
    })
  },
})

export const askCommand = defineCommand({
  meta: { name: 'ask', description: 'List and answer asks' },
  subCommands: { ls, answer },
})
