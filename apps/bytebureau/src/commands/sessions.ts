import { m } from '@bytebureau/i18n'
import type { AskRecord, SessionDto } from '@bytebureau/protocol'
import { defineCommand, type CommandDef } from 'citty'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'
import { sessionFields, sessionRows } from '../render/rows.js'
import { table } from '../render/tables.js'
import { withBureauRefusable } from './refusable.js'
import { promptCommand } from './sessions-prompt.js'

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
  for (const ask of asks) {
    context.output.print(m.sessions_pending_ask({ id: ask.id, title: ask.title }))
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

// Interrupt, stop and resume: one request, one line
const steer = (
  name: 'interrupt' | 'stop' | 'resume',
  description: string,
): CommandDef<typeof sessionArgs> =>
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
        context.output.print(m.sessions_done({ action: name, id: args.id }))
      }
    },
  })

export const sessionsCommand = defineCommand({
  meta: { name: 'sessions', description: 'List, inspect and steer sessions' },
  subCommands: {
    ls,
    show,
    prompt: promptCommand,
    interrupt: steer('interrupt', 'Interrupt the running turn of a session'),
    stop: steer('stop', 'Stop a session (resumable later)'),
    resume: steer('resume', 'Resume a stopped or errored session'),
  },
})
