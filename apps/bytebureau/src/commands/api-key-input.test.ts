import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { apiKeyFrom } from './api-key-input.js'

const never = async (): Promise<string> => {
  await Promise.resolve()
  return 'never'
}

// A terminal at which the text is typed; nothing typed is a cancelled prompt
const typing = (typed?: string) => async (): Promise<string | undefined> => {
  await Promise.resolve()
  return typed
}

describe(apiKeyFrom, () => {
  it('reads the first line of stdin where there is no terminal, trimmed, and refuses an empty one', async () => {
    expect.hasAssertions()
    const piped = Readable.from(['sk-test-key\nignored\n'])
    await expect(apiKeyFrom({ tty: false, stdin: piped, prompt: never })).resolves.toBe(
      'sk-test-key',
    )
    const empty = Readable.from(['\n'])
    await expect(apiKeyFrom({ tty: false, stdin: empty, prompt: never })).resolves.toBeUndefined()
  })

  it('joins the chunks of the line, and takes a last line without its newline', async () => {
    expect.hasAssertions()
    const chunked = Readable.from(['sk-', 'split\r\n'])
    await expect(apiKeyFrom({ tty: false, stdin: chunked, prompt: never })).resolves.toBe(
      'sk-split',
    )
    const unended = Readable.from(['  sk-last  '])
    await expect(apiKeyFrom({ tty: false, stdin: unended, prompt: never })).resolves.toBe('sk-last')
    const nothing = Readable.from([])
    await expect(apiKeyFrom({ tty: false, stdin: nothing, prompt: never })).resolves.toBeUndefined()
  })

  it('asks at a terminal, and takes a cancelled prompt as no key', async () => {
    expect.hasAssertions()
    const stdin = Readable.from([])
    await expect(apiKeyFrom({ tty: true, stdin, prompt: typing('sk-typed') })).resolves.toBe(
      'sk-typed',
    )
    const cancelled = apiKeyFrom({ tty: true, stdin, prompt: typing() })
    await expect(cancelled).resolves.toBeUndefined()
    const blank = apiKeyFrom({ tty: true, stdin, prompt: typing('   ') })
    await expect(blank).resolves.toBeUndefined()
  })
})
