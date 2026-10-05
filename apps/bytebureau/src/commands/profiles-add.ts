import { m } from '@bytebureau/i18n'
import type { AddProfileBody, ProfileDto, ProfileStatusDto } from '@bytebureau/protocol'
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

// The status of the profile, or none when it cannot be had: the profile is added all the same, and a retry would find it exists
async function statusOf(bureau: Bureau, id: string): Promise<ProfileStatusDto | undefined> {
  try {
    const status = await bureau.profiles.status(id)
    return status
  } catch {
    return undefined
  }
}

const tellStatuses = (output: Context['output'], statuses: readonly ProfileStatusDto[]): void => {
  for (const line of table(profileStatusRows(statuses))) {
    output.print(line)
  }
}

// The status of a login profile, told as a JSON record; an API-key profile has none to check
async function statusAfterAdd(
  bureau: Bureau,
  profile: ProfileDto,
  output: Context['output'],
): Promise<ProfileStatusDto | undefined> {
  const status = profile.kind === 'login' ? await statusOf(bureau, profile.id) : undefined
  if (status !== undefined) {
    output.emit({ command: 'profiles.status', statuses: [status] })
  }
  return status
}

// Only a logged-out profile is told to log in; the hint of another state, such as the reason of an unknown one, is no login
const loginHintOf = (status: ProfileStatusDto | undefined): string | undefined =>
  status !== undefined && status.state === 'loggedOut' ? status.hint : undefined

// Once the person says they have logged in, the status is checked again and told
async function checkedAfterLogin(
  bureau: Bureau,
  id: string,
  { context, wait }: Telling,
): Promise<void> {
  if (wait === undefined || !(await wait())) {
    return
  }
  const checked = await statusOf(bureau, id)
  tellStatuses(context.output, checked === undefined ? [] : [checked])
}

// A logged-out profile is told where to log in, and waited for at a terminal; any other status is told as its row
export async function tellAdded(
  bureau: Bureau,
  profile: ProfileDto,
  telling: Telling,
): Promise<void> {
  const { output } = telling.context
  const status = await statusAfterAdd(bureau, profile, output)
  const hint = loginHintOf(status)
  if (hint === undefined) {
    output.print(m.profiles_added({ id: profile.id }))
    tellStatuses(output, status === undefined ? [] : [status])
    return
  }
  output.print(m.profiles_added_login({ id: profile.id, hint }))
  await checkedAfterLogin(bureau, profile.id, telling)
}

interface KeyArgs {
  readonly provider: string
  readonly name: string
  readonly 'api-key': boolean
}

// The key of the profile, if it takes one, or why the command ends before anything is read or sent
interface KeyRead {
  readonly apiKey?: string | undefined
  readonly refusal?: string | undefined
}

// A positional beyond the provider and the name is a key typed as an argument, which the shell's history and the process list keep
async function keyRead(args: KeyArgs, positionals: number): Promise<KeyRead> {
  if (positionals > 2) {
    return { refusal: m.profiles_key_argument() }
  }
  if (!args['api-key']) {
    return {}
  }
  const apiKey = await apiKeyOf(`${args.provider}/${args.name}`)
  return apiKey === undefined ? { refusal: m.profiles_key_missing() } : { apiKey }
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
    const { apiKey, refusal } = await keyRead(args, args._.length)
    if (refusal !== undefined) {
      context.output.warn(refusal)
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
