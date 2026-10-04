import { m } from '@bytebureau/i18n'
import { defineCommand } from 'citty'
import { withBureau } from '../bureau/with-bureau.js'
import { bureauFlags, globalArgs, processContext } from '../context.js'

const ls = defineCommand({
  meta: { name: 'ls', description: 'List session worktrees' },
  args: { ...globalArgs, project: { type: 'string', description: 'Project id' } },
  async run({ args }) {
    const context = processContext(args)
    const workspaces = await withBureau(context, bureauFlags(args), async (bureau) => {
      const listed = await bureau.workspaces.list(args.project)
      return listed
    })
    context.output.emit({ command: 'workspaces.ls', workspaces })
    if (workspaces.length === 0) {
      context.output.print(m.workspaces_none())
      return
    }
    for (const workspace of workspaces) {
      context.output.print(
        `${workspace.sessionId}  ${workspace.branch}  ${workspace.sessionStatus}  ${workspace.path}`,
      )
    }
  },
})

const prune = defineCommand({
  meta: {
    name: 'prune',
    description:
      'Remove worktrees of finished sessions that are merged or pushed and older than the retain period',
  },
  args: { ...globalArgs, project: { type: 'string', description: 'Project id' } },
  async run({ args }) {
    const context = processContext(args)
    const report = await withBureau(context, bureauFlags(args), async (bureau) => {
      const pruned = await bureau.workspaces.prune(args.project)
      return pruned
    })
    context.output.emit({ command: 'workspaces.prune', ...report })
    for (const kept of report.retained) {
      context.output.print(`${kept.path}: ${kept.reason}`)
    }
    context.output.print(
      m.workspaces_pruned({ removed: report.removed.length, retained: report.retained.length }),
    )
  },
})

export const workspacesCommand = defineCommand({
  meta: { name: 'workspaces', description: 'Inspect and prune session worktrees' },
  subCommands: { ls, prune },
})
