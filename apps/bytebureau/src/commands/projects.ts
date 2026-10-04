import path from 'node:path'
import { m } from '@bytebureau/i18n'
import { defineCommand } from 'citty'
import { withBureau } from '../bureau/with-bureau.js'
import { bureauFlags, globalArgs, processContext } from '../context.js'
import { withBureauRefusable } from './refusable.js'

const ls = defineCommand({
  meta: { name: 'ls', description: 'List registered projects' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const projects = await withBureau(context, bureauFlags(args), async (bureau) => {
      const listed = await bureau.projects.list()
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
    // The daemon would resolve a relative path in its own working directory
    const directory = path.resolve(args.path ?? process.cwd())
    const project = await withBureau(context, bureauFlags(args), async (bureau) => {
      const registered = await bureau.projects.register(directory)
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
    // A project that sessions still belong to stays: that is a refusal, with its reason and exit code 1
    const removed = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      await bureau.projects.remove(args.id)
      return true
    })
    if (removed !== undefined) {
      context.output.emit({ command: 'projects.rm', id: args.id })
      context.output.print(m.projects_removed({ id: args.id }))
    }
  },
})

export const projectsCommand = defineCommand({
  meta: { name: 'projects', description: 'Manage registered projects' },
  subCommands: { ls, add, rm },
})
