import path from 'node:path'
import { defineCommand } from 'citty'
import { withBureau } from '../bureau/with-bureau.js'
import { bureauFlags, globalArgs, processContext } from '../context.js'
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
  },
  async run({ args }) {
    const context = processContext(args)
    const options = {
      prompt: args.prompt,
      // The daemon would resolve a relative path in its own working directory
      project: path.resolve(args.project ?? process.cwd()),
      branch: args.branch,
      employee: args.employee,
      provider: args.provider,
      yes: args.yes,
    }
    process.exitCode = await withBureau(context, bureauFlags(args), async (bureau) => {
      const code = await runSession(bureau, options, context)
      return code
    })
  },
})
