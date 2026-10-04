import path from 'node:path'
import { ApiError } from '@bytebureau/client'
import { m } from '@bytebureau/i18n'
import { WorkspaceError } from '@bytebureau/kernel'
import { defineCommand } from 'citty'
import type { BureauFlags } from '../bureau/resolve.js'
import { withBureau } from '../bureau/with-bureau.js'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'

// Why a project that sessions still belong to is not removed, as the kernel or the daemon says it; nothing for any other failure
function hasSessions(error: unknown): string | undefined {
  if (error instanceof WorkspaceError && error.code === 'has_sessions') {
    return error.reason
  }
  const problem = error instanceof ApiError ? error.problem : undefined
  return problem !== undefined && problem.code === 'workspace_has_sessions'
    ? problem.detail
    : undefined
}

// The project goes; one that sessions still belong to stays, a refusal with its reason and exit code 1 rather than a failure
async function removeProject(context: Context, flags: BureauFlags, id: string): Promise<boolean> {
  try {
    await withBureau(context, flags, async (bureau) => {
      await bureau.projects.remove(id)
    })
    return true
  } catch (error) {
    const refusal = hasSessions(error)
    if (refusal === undefined) {
      throw error
    }
    context.output.warn(refusal)
    process.exitCode = 1
    return false
  }
}

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
    if (await removeProject(context, bureauFlags(args), args.id)) {
      context.output.emit({ command: 'projects.rm', id: args.id })
      context.output.print(m.projects_removed({ id: args.id }))
    }
  },
})

export const projectsCommand = defineCommand({
  meta: { name: 'projects', description: 'Manage registered projects' },
  subCommands: { ls, add, rm },
})
