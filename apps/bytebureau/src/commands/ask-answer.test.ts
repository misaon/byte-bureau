import { describe, expect, it } from 'vitest'
import { askOf, option, question } from '../testing/events.js'
import { ASK } from '../testing/records.js'
import { contextOf } from '../testing/scripted-kernel.js'
import { answerOf, optionsOf } from './ask-answer.js'

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
