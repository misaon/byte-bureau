import type { Readable } from 'node:stream'
import { isatty } from 'node:tty'
import { m } from '@bytebureau/i18n'
import { isCancel, password } from '@clack/prompts'

export interface KeyInput {
  readonly tty: boolean
  readonly stdin: Readable
  // The hidden prompt of a terminal; undefined when the person cancels it
  readonly prompt: () => Promise<string | undefined>
}

const keyIn = (text: string): string | undefined => {
  const key = text.trim()
  return key === '' ? undefined : key
}

// The first line of stdin, trimmed; nothing when the line is empty or stdin ends without one
async function firstLine(stdin: Readable): Promise<string | undefined> {
  let text = ''
  for await (const chunk of stdin) {
    text += String(chunk)
    const end = text.indexOf('\n')
    if (end !== -1) {
      return keyIn(text.slice(0, end))
    }
  }
  return keyIn(text)
}

// A key comes from the terminal's hidden prompt, or from the first line of a pipe; never from an argument, which the process list shows
export async function apiKeyFrom(input: KeyInput): Promise<string | undefined> {
  if (input.tty) {
    const typed = await input.prompt()
    return typed === undefined ? undefined : keyIn(typed)
  }
  const piped = await firstLine(input.stdin)
  return piped
}

// Whether a person types at the stdin of the command
export const stdinIsTerminal = (): boolean => isatty(process.stdin.fd)

// The prompt goes to stderr, so the output of the command stays what it prints, JSON included
const hiddenPrompt = (id: string) => async (): Promise<string | undefined> => {
  const typed = await password({ message: m.profiles_key_prompt({ id }), output: process.stderr })
  return isCancel(typed) ? undefined : typed
}

// The key of the profile, typed at the terminal or piped on the stdin of the command
export async function apiKeyOf(id: string): Promise<string | undefined> {
  const tty = stdinIsTerminal()
  const key = await apiKeyFrom({ tty, stdin: process.stdin, prompt: hiddenPrompt(id) })
  return key
}
