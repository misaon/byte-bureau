import { isatty } from 'node:tty'
import { m, setLocale } from '@bytebureau/i18n'
import type { BureauFlags } from './bureau/resolve.js'
import { resolveLocale } from './locale.js'
import { colorEnabled, createOutput, type Output } from './output.js'
import { usageError } from './usage-error.js'

// The flags of every command
export const commonArgs = {
  lang: { type: 'string', description: 'UI language: en or cs' },
  json: { type: 'boolean', description: 'Machine-readable JSON output', default: false },
  color: {
    type: 'boolean',
    description: 'Colour output; pass --no-color to disable',
    default: true,
  },
  yes: {
    type: 'boolean',
    description: 'Answer every ask that has a recommended option with it',
    default: false,
  },
  debug: {
    type: 'string',
    description:
      'Debug logging for every category; --debug=<categories> picks some (bb.agent,!bb.store), always with =',
  },
  'log-level': { type: 'string', description: 'Log level: debug, info, warn or error' },
} as const

// The flags that choose the daemon a command talks to; a command that talks to none does not take them
const bureauArgs = {
  daemon: {
    type: 'boolean',
    description:
      'Talk to the daemon (started on demand); pass --no-daemon to run the kernel in-process',
    default: true,
  },
  host: { type: 'string', description: 'Host of a daemon to talk to (never started on demand)' },
  port: { type: 'string', description: 'Port of that daemon' },
  'token-file': { type: 'string', description: 'File holding the bearer token of that daemon' },
} as const

export const globalArgs = { ...commonArgs, ...bureauArgs } as const

export interface GlobalArgs {
  readonly lang?: string | undefined
  readonly json: boolean
  readonly color: boolean
  readonly yes: boolean
  readonly debug?: string | undefined
  readonly 'log-level'?: string | undefined
  // Citty gives false for --no-daemon alone; arguments made without the flag talk to the daemon too
  readonly daemon?: boolean | undefined
  readonly host?: string | undefined
  readonly port?: string | undefined
  readonly 'token-file'?: string | undefined
}

export interface Context {
  readonly output: Output
  readonly interactive: boolean
  readonly logging: {
    readonly debug: string | undefined
    readonly level: string | undefined
  }
  // The home of the command, the configuration it reads and the environment of a daemon it starts
  readonly env: Readonly<Record<string, string | undefined>>
}

export function createContext(
  args: GlobalArgs,
  env: Readonly<Record<string, string | undefined>>,
  stdoutIsTTY: boolean,
): Context {
  const { locale, unsupported } = resolveLocale({ flag: args.lang, env })
  setLocale(locale)
  const output = createOutput({
    json: args.json,
    color: colorEnabled(env, !args.color, stdoutIsTTY),
  })
  if (unsupported !== undefined) {
    output.warn(m.cli_unknown_locale({ locale: unsupported }))
  }
  return {
    output,
    interactive: stdoutIsTTY && !args.json,
    logging: { debug: args.debug, level: args['log-level'] },
    env,
  }
}

// The context of the running process: its environment, and whether its stdout is a terminal
export function processContext(args: GlobalArgs): Context {
  return createContext(args, process.env, isatty(process.stdout.fd))
}

// A port is a whole number up to 65535; 0 asks for a free one
export const portOf = (text: string | undefined): number | undefined => {
  if (text === undefined) {
    return undefined
  }
  const port = Number(text)
  if (!/^\d+$/u.test(text) || port > 65_535) {
    throw usageError(`--port takes a whole number from 0 to 65535, not ${text}`)
  }
  return port
}

// The Bureau the global flags ask for: the daemon of the home, the one --host and --port name, or the kernel in-process
export function bureauFlags(args: GlobalArgs): BureauFlags {
  if (args['token-file'] !== undefined && args.host === undefined && args.port === undefined) {
    throw usageError(
      '--token-file goes with --host or --port: it holds the token of the daemon they name',
    )
  }
  return {
    daemon: args.daemon !== false,
    host: args.host,
    port: portOf(args.port),
    tokenFile: args['token-file'],
  }
}

const BUREAU_FLAGS: ReadonlySet<string> = new Set([
  '--daemon',
  '--no-daemon',
  '--host',
  '--port',
  '--token-file',
])

// A command that talks to no daemon refuses the flags that choose one, which it would otherwise ignore; those it takes in a sense of its own are kept
// What follows -- is no flag
export function refuseBureauFlags(
  command: string,
  rawArgs: readonly string[],
  kept: readonly string[] = [],
): void {
  const end = rawArgs.indexOf('--')
  const flags = (end === -1 ? rawArgs : rawArgs.slice(0, end)).map(
    (arg) => arg.split('=')[0] ?? arg,
  )
  const refused = flags.find((flag) => BUREAU_FLAGS.has(flag) && !kept.includes(flag))
  if (refused !== undefined) {
    throw usageError(`${command} talks to no daemon: it takes no ${refused}`)
  }
}
