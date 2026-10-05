import { m } from '@bytebureau/i18n'
import type { ProfileStatusDto } from '@bytebureau/protocol'
import { defineCommand } from 'citty'
import type { Bureau } from '../bureau/bureau.js'
import { bureauFlags, globalArgs, processContext } from '../context.js'
import { profileRows, profileStatusRows } from '../render/rows.js'
import { table } from '../render/tables.js'
import { addCommand } from './profiles-add.js'
import { withBureauRefusable } from './refusable.js'

const idArg = {
  id: { type: 'positional', description: 'Profile id (provider/name)', required: true },
} as const

const ls = defineCommand({
  meta: { name: 'ls', description: 'List the profiles of every provider' },
  args: { ...globalArgs },
  async run({ args }) {
    const context = processContext(args)
    const profiles = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const listed = await bureau.profiles.list()
      return listed
    })
    if (profiles === undefined) {
      return
    }
    context.output.emit({ command: 'profiles.ls', profiles })
    if (profiles.length === 0) {
      context.output.print(m.profiles_none())
      return
    }
    for (const line of table(profileRows(profiles, m.profiles_default_marker()))) {
      context.output.print(line)
    }
  },
})

const rm = defineCommand({
  meta: { name: 'rm', description: 'Remove a profile; --purge removes its login directory too' },
  args: {
    ...globalArgs,
    ...idArg,
    purge: {
      type: 'boolean',
      description: 'Remove the login directory of the profile',
      default: false,
    },
  },
  async run({ args }) {
    const context = processContext(args)
    // A profile that a session can still run under stays: that is a refusal, with its reason and exit code 1
    const removed = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      await bureau.profiles.remove(args.id, { purge: args.purge })
      return true
    })
    if (removed !== undefined) {
      context.output.emit({ command: 'profiles.rm', id: args.id, purged: args.purge })
      context.output.print(m.profiles_removed({ id: args.id }))
    }
  },
})

const use = defineCommand({
  meta: { name: 'use', description: 'Make a profile the default of its provider' },
  args: { ...globalArgs, ...idArg },
  async run({ args }) {
    const context = processContext(args)
    const done = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      await bureau.profiles.setDefault(args.id)
      return true
    })
    if (done !== undefined) {
      context.output.emit({ command: 'profiles.use', id: args.id })
      context.output.print(m.profiles_default_set({ id: args.id }))
    }
  },
})

// The ids of the profile named, else of every profile
async function profileIds(bureau: Bureau, id: string | undefined): Promise<readonly string[]> {
  if (id !== undefined) {
    return [id]
  }
  const profiles = await bureau.profiles.list()
  return profiles.map((profile) => profile.id)
}

// The providers are asked about their profiles side by side
async function statusesOf(
  bureau: Bureau,
  id: string | undefined,
): Promise<readonly ProfileStatusDto[]> {
  const ids = await profileIds(bureau, id)
  const statuses = await Promise.all(
    ids.map(async (each) => {
      const checked = await bureau.profiles.status(each)
      return checked
    }),
  )
  return statuses
}

const status = defineCommand({
  meta: { name: 'status', description: 'Check the login of one profile, or of every profile' },
  args: {
    ...globalArgs,
    id: {
      type: 'positional',
      description: 'Profile id; every profile when left out',
      required: false,
    },
  },
  async run({ args }) {
    const context = processContext(args)
    const statuses = await withBureauRefusable(context, bureauFlags(args), async (bureau) => {
      const checked = await statusesOf(bureau, args.id)
      return checked
    })
    if (statuses === undefined) {
      return
    }
    context.output.emit({ command: 'profiles.status', statuses })
    if (statuses.length === 0) {
      context.output.print(m.profiles_status_none())
      return
    }
    for (const line of table(profileStatusRows(statuses))) {
      context.output.print(line)
    }
  },
})

export const profilesCommand = defineCommand({
  meta: { name: 'profiles', description: 'Manage the auth profiles of the agent providers' },
  subCommands: { ls, add: addCommand, rm, use, status },
})
