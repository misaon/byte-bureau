import { isatty } from 'node:tty'
import { m, setLocale } from '@bytebureau/i18n'
import { resolveLocale } from './locale.js'
import { colorEnabled, createOutput, type Output } from './output.js'

export const globalArgs = {
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

export interface GlobalArgs {
  readonly lang?: string | undefined
  readonly json: boolean
  readonly color: boolean
  readonly yes: boolean
  readonly debug?: string | undefined
  readonly 'log-level'?: string | undefined
}

export interface Context {
  readonly output: Output
  readonly interactive: boolean
  readonly logging: {
    readonly debug: string | undefined
    readonly level: string | undefined
  }
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
  }
}

// The context of the running process: its environment, and whether its stdout is a terminal
export function processContext(args: GlobalArgs): Context {
  return createContext(args, process.env, isatty(process.stdout.fd))
}
