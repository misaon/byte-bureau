import type { AskRecord } from '@bytebureau/protocol'
import { CANCEL_SYMBOL } from '@clack/prompts'
import { describe, expect, it } from 'vitest'
import type { Prompts } from '../render/ask-prompt.js'
import { askOf, option, question } from '../testing/events.js'
import { ASK } from '../testing/records.js'
import { captureConsole, contextOf, keepExitCode, scripted } from '../testing/scripted-kernel.js'
import { createContext } from '../context.js'
import { answerAsk, answerOf, optionsOf, type Answering } from './ask-answer.js'

describe(optionsOf, () => {
  it('reads every --option, spelled apart from its id or with an equals sign', () => {
    expect(
      optionsOf(['a1', '--option', 'yes', '--yes', '--option=default', '--option', 'x']),
    ).toStrictEqual(['yes', 'default', 'x'])
  })

  it('finds none when none is given, and none after --', () => {
    expect(optionsOf(['a1', '--other', 'words'])).toStrictEqual([])
    expect(optionsOf(['a1', '--', '--option', 'yes'])).toStrictEqual([])
  })

  it('keeps an id that begins with a dash, and leaves out an --option with no id after it', () => {
    expect(optionsOf(['--option', '-1', '--option'])).toStrictEqual(['-1'])
  })
})

const RECOMMENDED = { ...ASK, ...askOf([question([option('yes', true), option('no', false)])]) }
const UNRECOMMENDED = { ...ASK, ...askOf([question([option('a', false)])], 'none') }

describe(answerOf, () => {
  const nothing = { options: [], other: undefined, yes: false }

  it('answers with the options the flags name', async () => {
    expect.hasAssertions()
    const flags = { ...nothing, options: ['no', 'yes'] }
    await expect(answerOf(flags, RECOMMENDED, contextOf())).resolves.toStrictEqual({
      selected: ['no', 'yes'],
    })
  })

  it('answers with the words of the person, over any option', async () => {
    expect.hasAssertions()
    const flags = { options: ['yes'], other: 'A barrel file', yes: false }
    await expect(answerOf(flags, RECOMMENDED, contextOf())).resolves.toStrictEqual({
      selected: 'other',
      otherText: 'A barrel file',
    })
  })

  it('takes no empty words for an answer', async () => {
    expect.hasAssertions()
    const flags = { ...nothing, other: '' }
    await expect(answerOf(flags, RECOMMENDED, contextOf())).resolves.toBeUndefined()
  })

  it('picks the recommended option for --yes, off a terminal as well', async () => {
    expect.hasAssertions()
    const flags = { ...nothing, yes: true }
    await expect(answerOf(flags, RECOMMENDED, contextOf())).resolves.toStrictEqual({
      selected: ['yes'],
    })
  })

  it('has no answer for an ask nobody can answer: no flag, no terminal, nothing recommended', async () => {
    expect.hasAssertions()
    await expect(answerOf(nothing, RECOMMENDED, contextOf())).resolves.toBeUndefined()
    await expect(
      answerOf({ ...nothing, yes: true }, UNRECOMMENDED, contextOf()),
    ).resolves.toBeUndefined()
  })
})

// A person at a terminal who cancels whatever they are asked, as with Ctrl-C
const CANCELLING: Prompts = {
  select: async () => {
    await Promise.resolve()
    return CANCEL_SYMBOL
  },
  text: async () => {
    await Promise.resolve()
    return CANCEL_SYMBOL
  },
}

// A person at a terminal who picks the option of the id
const picking = (id: string): Prompts => ({
  select: async () => {
    await Promise.resolve()
    return id
  },
  text: CANCELLING.text,
})

const AT_A_TERMINAL = contextOf(false, true)

describe('answerOf with a person at a terminal', () => {
  const nothing = { options: [], other: undefined, yes: false }

  it('answers with what the person picks', async () => {
    expect.hasAssertions()
    const flags = { ...nothing, prompts: picking('no') }
    await expect(answerOf(flags, RECOMMENDED, AT_A_TERMINAL)).resolves.toStrictEqual({
      selected: ['no'],
    })
  })

  it('tells that the person cancelled the prompt, which asked them and got no answer', async () => {
    expect.hasAssertions()
    const flags = { ...nothing, prompts: CANCELLING }
    await expect(answerOf(flags, RECOMMENDED, AT_A_TERMINAL)).resolves.toBe('cancelled')
  })

  it('has no cancel to tell for --yes, which asks nobody: an ask with no recommendation has no answer', async () => {
    expect.hasAssertions()
    const flags = { ...nothing, yes: true, prompts: CANCELLING }
    await expect(answerOf(flags, UNRECOMMENDED, AT_A_TERMINAL)).resolves.toBeUndefined()
  })
})

const PENDING: AskRecord = { ...RECOMMENDED, id: 'a1' }
const REQUEST: Answering = { id: 'a1', options: [], other: undefined, yes: false }

// An ask that the kernel holds, or none
const holding = (ask: AskRecord | undefined) => async (): Promise<AskRecord | undefined> => {
  await Promise.resolve()
  return ask
}

describe(answerAsk, () => {
  it('answers the ask with the flags, and tells so', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const { bureau, answered } = scripted([], { getAsk: holding(PENDING) })
    await answerAsk(bureau, { ...REQUEST, options: ['yes'] }, contextOf())
    expect(answered).toStrictEqual([{ askId: 'a1', answer: { selected: ['yes'] } }])
    expect([printed.out(), printed.err(), process.exitCode]).toStrictEqual([
      ['Answered a1'],
      [],
      undefined,
    ])
  })

  it('ends a prompt that the person cancelled with exit code 1 and no line, and answers nothing', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const { bureau, answered } = scripted([], { getAsk: holding(PENDING) })
    await answerAsk(bureau, { ...REQUEST, prompts: CANCELLING }, AT_A_TERMINAL)
    expect([answered, printed.out(), printed.err()]).toStrictEqual([[], [], []])
    expect(process.exitCode).toBe(1)
  })
})

describe('answerAsk with --yes on an ask that recommends nothing', () => {
  const unrecommended: AskRecord = {
    ...PENDING,
    ...askOf([question([option('a', false)])], 'none'),
  }

  it.each([
    ['off a terminal', contextOf()],
    ['at a terminal, where nobody is asked for it', AT_A_TERMINAL],
  ])('refuses with its own line, %s', async (_where, context) => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const { bureau, answered } = scripted([], { getAsk: holding(unrecommended) })
    await answerAsk(bureau, { ...REQUEST, yes: true, prompts: CANCELLING }, context)
    expect([answered, process.exitCode]).toStrictEqual([[], 1])
    expect(printed.err()).toStrictEqual([
      'Ask a1 has no recommended option; pass --option or --other',
    ])
  })
})

describe('answerAsk in Czech', () => {
  it('tells that an ask recommends nothing, and what to pass, in the words of the language', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const czech = createContext({ json: false, color: false, yes: true, lang: 'cs' }, {}, false)
    const unrecommended: AskRecord = {
      ...PENDING,
      ...askOf([question([option('a', false)])], 'none'),
    }
    const { bureau } = scripted([], { getAsk: holding(unrecommended) })
    await answerAsk(bureau, { ...REQUEST, yes: true }, czech)
    expect(printed.err()).toStrictEqual([
      'Otázka a1 nemá doporučenou volbu; zadejte --option nebo --other',
    ])
  })
})

describe('answerAsk when there is no answer', () => {
  it('refuses when there is nobody to ask and nothing in the flags', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const { bureau, answered } = scripted([], { getAsk: holding(PENDING) })
    await answerAsk(bureau, REQUEST, contextOf())
    expect([answered, process.exitCode]).toStrictEqual([[], 1])
    expect(printed.err()).toStrictEqual(['Ask a1 needs --option or --other outside a terminal'])
  })

  it.each([
    ['an ask that is not there', undefined],
    ['an ask that is answered already', { ...PENDING, status: 'answered' } as const],
  ])('refuses %s', async (_what, held) => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const { bureau, answered } = scripted([], { getAsk: holding(held) })
    await answerAsk(bureau, { ...REQUEST, yes: true }, contextOf())
    expect([answered, process.exitCode]).toStrictEqual([[], 1])
    expect(printed.err()).toStrictEqual(['Ask a1 is not pending'])
  })

  it('tells the answer as a JSON record when the output is machine-readable', async () => {
    expect.hasAssertions()
    keepExitCode()
    const printed = captureConsole()
    const { bureau } = scripted([], { getAsk: holding(PENDING) })
    await answerAsk(bureau, { ...REQUEST, other: 'A barrel file' }, contextOf(true))
    const answer = { selected: 'other', otherText: 'A barrel file' }
    expect(printed.out()).toStrictEqual([
      JSON.stringify({ command: 'ask.answer', id: 'a1', answer }),
    ])
  })
})
