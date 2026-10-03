import { m } from '@bytebureau/i18n'
import { intro } from '@clack/prompts'
import { defineCommand } from 'citty'
import { globalArgs, processContext } from '../context.js'
import { withKernel } from '../kernel.js'
import { titleOf } from '../render/transcript.js'
import { runSession } from './run-session.js'

export const runCommand = defineCommand({
  meta: { name: 'run', description: 'Run one prompt through an employee in an isolated worktree' },
  args: {
    ...globalArgs,
    prompt: { type: 'positional', description: 'The task for the employee', required: true },
    project: { type: 'string', description: 'Project path (default: current directory)' },
    branch: { type: 'string', description: 'Base branch (default: the project default branch)' },
    employee: { type: 'string', description: 'Employee id from bytebureau.json' },
    provider: { type: 'string', description: 'Agent provider id (fake, claude, acp:<preset>)' },
    'no-daemon': {
      type: 'boolean',
      description: 'Run the kernel in-process (the only mode in this phase)',
      default: true,
    },
  },
  async run({ args }) {
    const context = processContext(args)
    if (context.interactive) {
      const title = titleOf(args.prompt)
      intro(context.output.colors.bold(m.run_intro({ title })))
    }
    const options = {
      prompt: args.prompt,
      project: args.project ?? process.cwd(),
      branch: args.branch,
      employee: args.employee,
      provider: args.provider,
      yes: args.yes,
    }
    process.exitCode = await withKernel(context, process.env, async (kernel) => {
      const code = await runSession(kernel, options, context)
      return code
    })
  },
})
