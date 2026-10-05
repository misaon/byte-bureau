import { m } from '@bytebureau/i18n'
import type { AskRecord, SessionDto } from '@bytebureau/protocol'
import { defineCommand, type CommandDef } from 'citty'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'
import { pendingAskLines, sessionFields, sessionRows } from '../render/rows.js'
import { table } from '../render/tables.js'
import { withBureauRefusable } from './refusable.js'
import { promptSession } from './sessions-prompt.js'

const sessionArgs = {
  ...globalArgs,
  id: { type: 'positional', description: 'Session id', required: true },
} as const

function tellSessions(context: Context, sessions: readonly SessionDto[]): void {
  context.output.emit({ command: 'sessions.ls', sessions })
  if (sessions.length === 0) {
    context.output.print(m.sessions_none())
    return
  }
  for (const line of table(sessionRows(sessions))) {
    context.output.print(line)
  }
}

const ls = defineCommand({
  meta: { name: 'ls', description: 'List sessions' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const sessions = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const listed = await bureau.sessions.list()
      return listed
    })
    if (sessions !== undefined) {
      tellSessions(context, sessions)
    }
  },
})

// The fields of a session, one to a line, and the asks that wait for an answer to it
function tellSession(context: Context, session: SessionDto, asks: readonly AskRecord[]): void {
  for (const line of table(sessionFields(session))) {
    context.output.print(line)
  }
  for (const line of pendingAskLines(asks)) {
    context.output.print(line)
  }
}

const show = defineCommand({
  meta: { name: 'show', description: 'Show one session and its pending asks' },
  args: sessionArgs,
  async run({ args }) {
    const context = processContext(args)
    const shown = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const session = await bureau.sessions.get(args.id)
      const asks = session === undefined ? [] : await bureau.asks.pending(session.id)
      return { session, asks }
    })
    if (shown === undefined) {
      return
    }
    if (shown.session === undefined) {
      context.output.warn(m.sessions_missing({ id: args.id }))
      process.exitCode = 1
      return
    }
    context.output.emit({ command: 'sessions.show', session: shown.session, asks: shown.asks })
    tellSession(context, shown.session, shown.asks)
  },
})

const prompt = defineCommand({
  meta: { name: 'prompt', description: 'Prompt a session and follow its turn to the end' },
  args: {
    ...globalArgs,
    id: { type: 'positional', description: 'Session id', required: true },
    text: { type: 'positional', description: 'The prompt', required: true },
  },
  async run({ args }) {
    const context = processContext(args)
    const options = { id: args.id, text: args.text, yes: args.yes }
    const code = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const ended = await promptSession(bureau, options, context)
      return ended
    })
    if (code !== undefined) {
      process.exitCode = code
    }
  },
})

// What each of them tells once it is done, in a line of its own
const DONE = {
  interrupt: m.sessions_interrupted,
  stop: m.sessions_stopped,
  resume: m.sessions_resumed,
  complete: m.sessions_completed,
} as const

// Interrupt, stop, resume and complete: one request, one line
const steer = (name: keyof typeof DONE, description: string): CommandDef<typeof sessionArgs> =>
  defineCommand({
    meta: { name, description },
    args: sessionArgs,
    async run({ args }) {
      const context = processContext(args)
      const done = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
        await bureau.sessions[name](args.id)
        return true
      })
      if (done !== undefined) {
        context.output.emit({ command: `sessions.${name}`, id: args.id })
        context.output.print(DONE[name]({ id: args.id }))
      }
    },
  })

export const sessionsCommand = defineCommand({
  meta: { name: 'sessions', description: 'List, inspect and steer sessions' },
  subCommands: {
    ls,
    show,
    prompt,
    interrupt: steer('interrupt', 'Interrupt the running turn of a session'),
    stop: steer('stop', 'Stop a session (resumable later)'),
    resume: steer('resume', 'Resume a stopped or errored session'),
    complete: steer(
      'complete',
      'Complete a ready, stopped or errored session: it ends for good, and lets go of its profile',
    ),
  },
})
