import { setLocale } from '@bytebureau/i18n'
import { CANCEL_SYMBOL } from '@clack/prompts'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { AskOption } from '@bytebureau/protocol'
import { askOf, option, question } from '../testing/events.js'
import { promptAsk, type Prompts } from './ask-prompt.js'

type Selected = Awaited<ReturnType<Prompts['select']>>
type SelectOptions = Parameters<Prompts['select']>[0]

interface Person {
  readonly prompts: Prompts
  readonly seen: readonly SelectOptions[]
  readonly typed: readonly string[]
}

// A person who picks the given values in turn and, asked for words, writes the given text
function person(picks: readonly Selected[], writes: readonly Selected[] = []): Person {
  const seen: SelectOptions[] = []
  const typed: string[] = []
  const picked = [...picks]
  const written = [...writes]
  const prompts: Prompts = {
    select: async (options) => {
      seen.push(options)
      const pick = await Promise.resolve(picked.shift())
      return pick ?? CANCEL_SYMBOL
    },
    text: async (options) => {
      typed.push(options.message)
      const words = await Promise.resolve(written.shift())
      return words ?? CANCEL_SYMBOL
    },
  }
  return { prompts, seen, typed }
}

// The words of the first question the person was shown
function firstMessage(asked: Person): string {
  const [first] = asked.seen
  return first === undefined ? '' : first.message
}

// The labels of the first question the person was shown
function firstLabels(asked: Person): (string | undefined)[] {
  const [first] = asked.seen
  return first === undefined ? [] : first.options.map((choice) => choice.label)
}

// An option whose label the agent chose
function labelled(id: string, recommended: boolean, label: string): AskOption {
  return { ...option(id, recommended), label }
}

const NAMED_OR_DEFAULT = question([option('yes', true), option('default', false)])
const LATER = question([option('no', false), option('later', true)])
const NOBODY = { yes: false, interactive: false }
const AUTOMATIC = { yes: true, interactive: false }
const TERMINAL = { yes: false, interactive: true }

describe('promptAsk with --yes', () => {
  it('answers every question with its recommended option and asks nobody', async () => {
    expect.hasAssertions()
    const nobody = person([])
    const answer = await promptAsk(askOf([NAMED_OR_DEFAULT, LATER]), AUTOMATIC, nobody.prompts)
    expect(answer).toStrictEqual({ selected: ['yes', 'later'] })
    expect(nobody.seen).toHaveLength(0)
  })

  it('leaves the ask to the kernel policy when the ask has no recommendation', async () => {
    expect.hasAssertions()
    const none = askOf([question([option('allow', false), option('deny', false)])], 'none')
    await expect(promptAsk(none, AUTOMATIC)).resolves.toBeUndefined()
  })

  it('leaves the ask alone when a question has no recommended option, or several', async () => {
    expect.hasAssertions()
    const unrecommended = question([option('a', false), option('b', false)])
    const doubled = question([option('a', true), option('b', true)])
    await expect(
      promptAsk(askOf([NAMED_OR_DEFAULT, unrecommended]), AUTOMATIC),
    ).resolves.toBeUndefined()
    await expect(promptAsk(askOf([doubled]), AUTOMATIC)).resolves.toBeUndefined()
  })
})

describe('promptAsk without a person to ask', () => {
  it('returns nothing, so the kernel policy decides, and asks nobody', async () => {
    expect.hasAssertions()
    const nobody = person([])
    await expect(
      promptAsk(askOf([NAMED_OR_DEFAULT]), NOBODY, nobody.prompts),
    ).resolves.toBeUndefined()
    expect(nobody.seen).toHaveLength(0)
  })
})

describe('promptAsk at the terminal', () => {
  it('starts on the recommended option, marks it and shows its description as a hint', async () => {
    expect.hasAssertions()
    const described = question([
      option('yes', true, 'Matches the modules'),
      option('default', false),
    ])
    const asked = person(['default'])
    const answer = await promptAsk(askOf([described]), TERMINAL, asked.prompts)
    expect(answer).toStrictEqual({ selected: ['default'] })
    expect(asked.seen).toStrictEqual([
      {
        message: 'The employee asks: Should hello() be a named export?',
        initialValue: 'yes',
        options: [
          { value: 'yes', label: 'Option yes (Recommended)', hint: 'Matches the modules' },
          { value: 'default', label: 'Option default' },
        ],
      },
    ])
  })

  it('starts on the first option when none is recommended and offers "Other" when allowed', async () => {
    expect.hasAssertions()
    const open = question([option('a', false), option('b', false)], true)
    const asked = person(['a'])
    await promptAsk(askOf([open]), TERMINAL, asked.prompts)
    expect(asked.seen).toMatchObject([
      {
        initialValue: 'a',
        options: [{ value: 'a' }, { value: 'b' }, { value: '__other__', label: 'Other…' }],
      },
    ])
  })
})

describe('promptAsk and the marker of a recommended label', () => {
  it('does not mark a label twice when the agent marked it itself', async () => {
    expect.hasAssertions()
    const marked = question([
      labelled('yes', true, 'Named export (Recommended)'),
      labelled('default', false, 'Default export'),
    ])
    const asked = person(['yes'])
    await promptAsk(askOf([marked]), TERMINAL, asked.prompts)
    expect(firstLabels(asked)).toStrictEqual(['Named export (Recommended)', 'Default export'])
  })

  it('knows the Czech marker, and any case, in either language', async () => {
    expect.hasAssertions()
    const marked = question([
      labelled('a', true, 'Pojmenovaný export (doporučeno)'),
      labelled('b', true, 'Named export (RECOMMENDED) '),
      labelled('c', true, 'Výchozí export (Doporučeno)'),
    ])
    const asked = person(['a'])
    await promptAsk(askOf([marked]), TERMINAL, asked.prompts)
    expect(firstLabels(asked)).toStrictEqual([
      'Pojmenovaný export (doporučeno)',
      'Named export (RECOMMENDED) ',
      'Výchozí export (Doporučeno)',
    ])
  })

  it('marks a recommended label that does not end with a marker, and no other', async () => {
    expect.hasAssertions()
    const plain = question([
      labelled('a', true, 'Use the (Recommended) path'),
      labelled('b', false, 'Keep it (Recommended)'),
    ])
    const asked = person(['a'])
    await promptAsk(askOf([plain]), TERMINAL, asked.prompts)
    expect(firstLabels(asked)).toStrictEqual([
      'Use the (Recommended) path (Recommended)',
      'Keep it (Recommended)',
    ])
  })
})

describe('promptAsk at the terminal, question after question', () => {
  it('puts the questions one after the other and collects the choices', async () => {
    expect.hasAssertions()
    const asked = person(['yes', 'no'])
    const answer = await promptAsk(askOf([NAMED_OR_DEFAULT, LATER]), TERMINAL, asked.prompts)
    expect(answer).toStrictEqual({ selected: ['yes', 'no'] })
    expect(asked.seen).toHaveLength(2)
  })

  it('speaks the language that is set', async () => {
    expect.hasAssertions()
    onTestFinished(() => {
      setLocale('en')
    })
    setLocale('cs')
    const asked = person(['yes'])
    await promptAsk(askOf([NAMED_OR_DEFAULT]), TERMINAL, asked.prompts)
    expect(firstMessage(asked)).toMatch(/^Zaměstnanec se ptá: /u)
  })
})

describe('promptAsk when the person writes an answer or gives up', () => {
  const open = askOf([question([option('a', true)], true)])

  it('takes the words of the person for "Other"', async () => {
    expect.hasAssertions()
    const asked = person(['__other__'], ['use a class'])
    await expect(promptAsk(open, TERMINAL, asked.prompts)).resolves.toStrictEqual({
      selected: 'other',
      otherText: 'use a class',
    })
    expect(asked.typed).toStrictEqual(['Your answer'])
  })

  it('returns nothing when the person cancels at the choice', async () => {
    expect.hasAssertions()
    const asked = person([CANCEL_SYMBOL])
    await expect(promptAsk(open, TERMINAL, asked.prompts)).resolves.toBeUndefined()
    expect(asked.typed).toHaveLength(0)
  })

  it('returns nothing when the person cancels at the words', async () => {
    expect.hasAssertions()
    const asked = person(['__other__'], [CANCEL_SYMBOL])
    await expect(promptAsk(open, TERMINAL, asked.prompts)).resolves.toBeUndefined()
  })
})
