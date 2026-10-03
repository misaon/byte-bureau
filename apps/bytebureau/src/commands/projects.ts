import { m } from '@bytebureau/i18n'
import { defineCommand } from 'citty'
import { globalArgs, processContext } from '../context.js'
import { withKernel } from '../kernel.js'

const ls = defineCommand({
  meta: { name: 'ls', description: 'List registered projects' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const projects = await withKernel(context, process.env, async (kernel) => {
      const listed = await kernel.projects.list()
      return listed
    })
    context.output.emit({ command: 'projects.ls', projects })
    if (projects.length === 0) {
      context.output.print(m.projects_none())
      return
    }
    for (const project of projects) {
      context.output.print(
        `${project.id}  ${project.name}  ${project.path}  (${project.defaultBranch})`,
      )
    }
  },
})

const add = defineCommand({
  meta: { name: 'add', description: 'Register a project (default: current directory)' },
  args: {
    ...globalArgs,
    path: { type: 'positional', description: 'Project path', required: false },
  },
  async run({ args }) {
    const context = processContext(args)
    const project = await withKernel(context, process.env, async (kernel) => {
      const registered = await kernel.projects.register(args.path ?? process.cwd())
      return registered
    })
    context.output.emit({ command: 'projects.add', project })
    context.output.print(m.projects_added({ name: project.name, path: project.path }))
  },
})

const rm = defineCommand({
  meta: {
    name: 'rm',
    description:
      'Unregister a project; its worktrees are kept, and it fails while sessions of the project exist',
  },
  args: { ...globalArgs, id: { type: 'positional', description: 'Project id', required: true } },
  async run({ args }) {
    const context = processContext(args)
    await withKernel(context, process.env, async (kernel) => {
      await kernel.projects.remove(args.id)
    })
    context.output.emit({ command: 'projects.rm', id: args.id })
    context.output.print(m.projects_removed({ id: args.id }))
  },
})

export const projectsCommand = defineCommand({
  meta: { name: 'projects', description: 'Manage registered projects' },
  subCommands: { ls, add, rm },
})
