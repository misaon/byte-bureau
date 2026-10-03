import { m } from '@bytebureau/i18n'
import { intro, log, outro } from '@clack/prompts'
import { defineCommand } from 'citty'
import { globalArgs, processContext, type Context } from '../context.js'

function greeting(name: string | undefined): string {
  return name === undefined || name.trim() === '' ? m.hello_anonymous() : m.hello_greeting({ name })
}

function runHello({ output, interactive }: Context, name: string | undefined): void {
  const message = greeting(name)
  if (output.json) {
    output.emit({ command: 'hello', message })
    return
  }
  if (interactive) {
    intro(output.colors.bold(m.hello_intro()))
    log.message(message)
    outro(m.hello_outro())
    return
  }
  output.print(message)
}

export const helloCommand = defineCommand({
  meta: { name: 'hello', description: 'Print a localised greeting (build and i18n proof)' },
  args: {
    ...globalArgs,
    name: { type: 'positional', description: 'Who to greet', required: false },
  },
  run({ args }) {
    const context = processContext(args)
    runHello(context, args.name)
  },
})
