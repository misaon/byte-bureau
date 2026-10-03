import { stripVTControlCharacters } from 'node:util'
import { SessionError } from '@bytebureau/kernel'
import { S_BAR_END, S_BAR_START } from '@clack/prompts'
import { describe, expect, it } from 'vitest'
import { event } from '../testing/events.js'
import {
  captureConsole,
  captureTerminal,
  COMPLETED,
  contextOf,
  OPTIONS,
  rejecting,
  scripted,
  TURN_DONE,
} from '../testing/scripted-kernel.js'
import { runSession, type RunOptions } from './run-session.js'

const AT_A_TERMINAL = contextOf(false, true)
const ONE_FRAME = { starts: 1, ends: 1 }
const WRITE = event(
  'tool.started',
  { id: 't1', name: 'Write', kind: 'builtin', input: { path: 'src/hello.ts' } },
  1,
)

// The lines that begin with the glyph and the two spaces clack puts after it; the ASCII glyphs of TERM=linux turn up inside the words as well (the end of the frame is an em dash)
function linesStartingWith(text: string, glyph: string): number {
  const lines = stripVTControlCharacters(text).split('\n')
  return lines.filter((line) => line.startsWith(`${glyph}  `)).length
}

// How often the frame was opened and closed
function frames(text: string): { readonly starts: number; readonly ends: number } {
  return {
    starts: linesStartingWith(text, S_BAR_START),
    ends: linesStartingWith(text, S_BAR_END),
  }
}

// Whether the parts are in the text, one after the other
function inOrder(text: string, parts: readonly string[]): boolean {
  const places = parts.map((part) => text.indexOf(part))
  return places.every((place, index) => place >= 0 && place > (places[index - 1] ?? -1))
}

interface Ended {
  readonly code: number
  readonly terminal: string
  // What was printed as plain lines, to stdout and to stderr
  readonly stdout: readonly string[]
  readonly stderr: readonly string[]
}

// A run at a terminal: the code it ends with, what was written to the terminal and what went to stderr
async function endedAtTerminal(
  scriptedKernel: ReturnType<typeof scripted>,
  options: RunOptions = OPTIONS,
): Promise<Ended> {
  const printed = captureConsole()
  const written = captureTerminal()
  const code = await runSession(scriptedKernel.kernel, options, AT_A_TERMINAL)
  return { code, terminal: written(), stdout: printed.out(), stderr: printed.err() }
}

describe('runSession at a terminal', () => {
  it('opens a frame with the session, prints the lines inside it and closes it with the closing words', async () => {
    expect.hasAssertions()
    const ended = await endedAtTerminal(scripted([WRITE, TURN_DONE, COMPLETED]))
    const story = ['ByteBureau session Fix the build', '⚙ Write src/hello.ts', 'Done — turns: 1']
    expect(ended.code).toBe(0)
    expect(frames(ended.terminal)).toStrictEqual(ONE_FRAME)
    expect(inOrder(ended.terminal, story)).toBe(true)
    expect([...ended.stdout, ...ended.stderr]).toStrictEqual([])
  })

  it('closes the frame with the refusal when the named provider is unknown', async () => {
    expect.hasAssertions()
    const options = { ...OPTIONS, provider: 'nope' }
    const { code, terminal, stderr } = await endedAtTerminal(scripted([COMPLETED]), options)
    expect(code).toBe(4)
    expect(frames(terminal)).toStrictEqual(ONE_FRAME)
    expect(terminal).toContain('Provider "nope" is not available. Available: fake')
    expect(stderr).toStrictEqual([])
  })

  it('closes the frame with the refusal of the kernel when it refuses the provider of the employee', async () => {
    expect.hasAssertions()
    const refusal = new SessionError({
      code: 'provider_missing',
      reason: 'provider "claude" is not available; available: fake',
    })
    const refused = scripted([COMPLETED], { create: rejecting(refusal) })
    const { code, terminal, stderr } = await endedAtTerminal(refused)
    expect(code).toBe(4)
    expect(frames(terminal)).toStrictEqual(ONE_FRAME)
    expect(terminal).toContain(
      'provider "claude" is not available; available: fake (provider_missing)',
    )
    expect(stderr).toStrictEqual([])
  })

  it('closes the frame, and lets any other failure go on to the runner', async () => {
    expect.hasAssertions()
    captureConsole()
    const written = captureTerminal()
    const failure = new Error('the store is gone')
    const { kernel } = scripted([COMPLETED], { create: rejecting(failure) })
    await expect(runSession(kernel, OPTIONS, AT_A_TERMINAL)).rejects.toBe(failure)
    expect(frames(written())).toStrictEqual(ONE_FRAME)
    expect(written()).not.toContain('the store is gone')
  })
})

describe('runSession to a pipe', () => {
  it('draws no frame, and tells a refusal on stderr', async () => {
    expect.hasAssertions()
    const printed = captureConsole()
    const written = captureTerminal()
    const { kernel } = scripted([COMPLETED])
    await expect(runSession(kernel, { ...OPTIONS, provider: 'nope' }, contextOf())).resolves.toBe(4)
    expect(written()).toBe('')
    expect(printed.err()).toStrictEqual(['Provider "nope" is not available. Available: fake'])
  })
})
