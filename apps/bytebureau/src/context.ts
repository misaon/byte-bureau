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
} as const

export interface GlobalArgs {
  readonly lang?: string | undefined
  readonly json: boolean
  readonly color: boolean
}

export interface Context {
  readonly output: Output
  readonly interactive: boolean
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
  return { output, interactive: stdoutIsTTY && !args.json }
}
