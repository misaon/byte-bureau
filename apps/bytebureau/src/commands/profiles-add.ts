import { m } from '@bytebureau/i18n'
import type { AddProfileBody, ProfileDto } from '@bytebureau/protocol'
import { confirm } from '@clack/prompts'
import { defineCommand } from 'citty'
import type { Bureau } from '../bureau/bureau.js'
import { bureauFlags, globalArgs, processContext, type Context } from '../context.js'
import { profileStatusRows } from '../render/rows.js'
import { table } from '../render/tables.js'
import { apiKeyOf, stdinIsTerminal } from './api-key-input.js'
import { withBureauRefusable } from './refusable.js'

const ADD_ARGS = {
  ...globalArgs,
  provider: {
    type: 'positional',
    description: 'Provider id (claude, acp:codex, …)',
    required: true,
  },
  name: {
    type: 'positional',
    description: 'Profile name (lower-case letters, digits, dashes)',
    required: true,
  },
  'api-key': {
    type: 'boolean',
    description: 'An API-key profile; the key is read from the terminal or the first line of stdin',
    default: false,
  },
  default: {
    type: 'boolean',
    description: 'Make it the default profile of its provider',
    default: false,
  },
} as const

// What the person tells once they have logged in: anything but a yes checks nothing
async function loggedInAtTerminal(): Promise<boolean> {
  const done = await confirm({ message: m.profiles_wait_login(), initialValue: true })
  return done === true
}

interface ProfileArgs {
  readonly provider: string
  readonly name: string
  readonly default: boolean
}

const bodyOf = (args: ProfileArgs, apiKey: string | undefined): AddProfileBody => ({
  providerId: args.provider,
  name: args.name,
  kind: apiKey === undefined ? 'login' : 'api_key',
  ...(apiKey === undefined ? {} : { apiKey }),
  ...(args.default ? { makeDefault: true } : {}),
})

export interface Telling {
  readonly context: Context
  // Waits for the person to log in, true once they have; none off a terminal or with --yes
  readonly wait: (() => Promise<boolean>) | undefined
}

// Once the person says they have logged in, the status is checked again and told
async function checkedAfterLogin(
  bureau: Bureau,
  id: string,
  { context, wait }: Telling,
): Promise<void> {
  if (wait === undefined || !(await wait())) {
    return
  }
  const checked = await bureau.profiles.status(id)
  for (const line of table(profileStatusRows([checked]))) {
    context.output.print(line)
  }
}

// A login profile is told where to log in, which its status hints; at a terminal the command waits for the login and tells what it finds
export async function tellAdded(
  bureau: Bureau,
  profile: ProfileDto,
  telling: Telling,
): Promise<void> {
  const { output } = telling.context
  const status = profile.kind === 'login' ? await bureau.profiles.status(profile.id) : undefined
  if (status !== undefined) {
    output.emit({ command: 'profiles.status', statuses: [status] })
  }
  if (status === undefined || status.hint === undefined) {
    output.print(m.profiles_added({ id: profile.id }))
    return
  }
  output.print(m.profiles_added_login({ id: profile.id, hint: status.hint }))
  await checkedAfterLogin(bureau, profile.id, telling)
}

export const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Add a profile: a login directory, or an API key read from the prompt or stdin',
  },
  args: ADD_ARGS,
  async run({ args }) {
    const context = processContext(args)
    const flags = bureauFlags(args)
    const apiKey = args['api-key'] ? await apiKeyOf(`${args.provider}/${args.name}`) : undefined
    if (args['api-key'] && apiKey === undefined) {
      context.output.warn(m.profiles_key_missing())
      process.exitCode = 1
      return
    }
    const waits = context.interactive && !args.yes && stdinIsTerminal()
    await withBureauRefusable(context, flags, async (bureau) => {
      const profile = await bureau.profiles.add(bodyOf(args, apiKey))
      context.output.emit({ command: 'profiles.add', profile })
      await tellAdded(bureau, profile, { context, wait: waits ? loggedInAtTerminal : undefined })
    })
  },
})
