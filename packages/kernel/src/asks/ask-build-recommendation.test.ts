import { describe, expect, it } from 'vitest'
import { buildAsk, unrecommendedQuestions, type OpenAskInput } from './ask-build.js'
import { asking, option, question, request } from './ask-fixtures.js'

const build = (overrides: Partial<OpenAskInput> = {}): ReturnType<typeof buildAsk> =>
  buildAsk(request('s1', overrides))

const recommended = asking('q2', [option('x', false), option('y', true)])
const unmarked = asking('q2', [option('x', false), option('y', false)])
const twice = asking('q3', [option('a', true), option('b', true)])

describe('buildAsk and the recommendation of the agent', () => {
  it('takes a recommendation to be one recommended option in every question', () => {
    const ask = build({ questions: [question, recommended] })
    expect(ask.recommendationSource).toBe('agent')
  })

  it.each([
    { label: 'one of two questions without a recommended option', questions: [question, unmarked] },
    { label: 'no recommended option at all', questions: [unmarked] },
    { label: 'two recommended options in one question', questions: [twice] },
    { label: 'one recommended and one doubled question', questions: [question, twice] },
    { label: 'no question', questions: [] },
  ])('counts it for nothing with $label', ({ questions }) => {
    expect(build({ questions }).recommendationSource).toBe('none')
  })
})

describe('buildAsk and an employee that works on its own', () => {
  it.each(['autonomous', 'yolo'] as const)(
    'makes a %s employee wait for a question that is not fully recommended',
    (permissionMode) => {
      const ask = build({ permissionMode, questions: [question, unmarked] })
      expect(ask.policy).toStrictEqual({ onTimeout: 'wait', timeout: '30m' })
      expect(ask.deadlineAt).toBeNull()
    },
  )

  it.each(['autonomous', 'yolo'] as const)(
    'lets a %s employee proceed once every question is recommended',
    (permissionMode) => {
      const ask = build({ permissionMode, questions: [question, recommended] })
      expect(ask.policy).toStrictEqual({ onTimeout: 'recommended', timeout: '30m' })
      expect(ask.deadlineAt).not.toBeNull()
    },
  )

  it('makes it wait when the recommendation is declared to be none', () => {
    const ask = build({ permissionMode: 'autonomous', recommendationSource: 'none' })
    expect(ask.policy.onTimeout).toBe('wait')
  })

  it('never reads the timeout of a question it will wait for', () => {
    const ask = build({ permissionMode: 'autonomous', questions: [unmarked], askTimeout: '1x' })
    expect(ask.policy).toStrictEqual({ onTimeout: 'wait', timeout: '1x' })
  })

  it('keeps the denial of a permission that nothing recommends', () => {
    const toolCall = { name: 'Mystery', input: {} }
    const ask = build({ permissionMode: 'autonomous', kind: 'permission', toolCall })
    expect(ask.recommendationSource).toBe('none')
    expect(ask.policy).toStrictEqual({ onTimeout: 'deny', timeout: '30m' })
  })
})

describe(unrecommendedQuestions, () => {
  it('names the questions without exactly one recommended option', () => {
    const ask = build({ questions: [question, unmarked, twice] })
    expect(unrecommendedQuestions(ask)).toStrictEqual(['q2', 'q3'])
  })

  it('names nothing when every question is recommended', () => {
    expect(unrecommendedQuestions(build({ questions: [question, recommended] }))).toStrictEqual([])
  })

  it('names the question of a permission that no rule recommends anything for', () => {
    const toolCall = { name: 'Mystery', input: {} }
    expect(unrecommendedQuestions(build({ kind: 'permission', toolCall }))).toStrictEqual([
      'permission',
    ])
  })
})
