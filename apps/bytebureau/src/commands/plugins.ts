import { m } from '@bytebureau/i18n'
import { defineCommand } from 'citty'
import { bureauFlags, globalArgs, processContext } from '../context.js'
import { pluginRows } from '../render/rows.js'
import { table } from '../render/tables.js'
import { withBureauRefusable } from './refusable.js'

const ls = defineCommand({
  meta: { name: 'ls', description: 'List the loaded plugins and the ports they offer' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const plugins = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const listed = await bureau.plugins.list()
      return listed
    })
    if (plugins === undefined) {
      return
    }
    context.output.emit({ command: 'plugins.ls', plugins })
    if (plugins.length === 0) {
      context.output.print(m.plugins_none())
      return
    }
    for (const line of table(pluginRows(plugins))) {
      context.output.print(line)
    }
  },
})

export const pluginsCommand = defineCommand({
  meta: { name: 'plugins', description: 'Inspect plugins' },
  subCommands: { ls },
})
