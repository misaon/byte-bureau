import { describe, expect, it } from 'vitest'
import { answersOf, questionsOf } from './ask-questions.js'

// Two questions of one AskUserQuestion, each with the option the agent recommends marked by its label
const TWO = questionsOf({
  questions: [
    {
      question: 'Which export?',
      header: 'Export',
      options: [
        { label: 'Named (Recommended)', description: 'Matches the modules' },
        { label: 'Default' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which test runner?',
      header: 'Tests',
      options: [{ label: 'Vitest' }, { label: 'Jest (Recommended)' }],
      multiSelect: false,
    },
  ],
})

describe(questionsOf, () => {
  it('gives an option its plain label as its id, the marker of the recommended one left out of both', () => {
    const options = TWO.map((question) =>
      question.options.map((option) => [option.id, option.label, option.recommended]),
    )
    expect(options).toStrictEqual([
      [
        ['Named', 'Named', true],
        ['Default', 'Default', false],
      ],
      [
        ['Vitest', 'Vitest', false],
        ['Jest', 'Jest', true],
      ],
    ])
  })
})

describe(answersOf, () => {
  it('answers every question with the label of the option chosen for it', () => {
    expect(answersOf(TWO, { selected: ['Named', 'Jest'] })).toStrictEqual({
      'Which export?': 'Named',
      'Which test runner?': 'Jest',
    })
  })

  it('answers the first question alone with the text of a person who chose none of the options', () => {
    expect(answersOf(TWO, { selected: 'other', otherText: 'Both' })).toStrictEqual({
      'Which export?': 'Both',
    })
  })
})
