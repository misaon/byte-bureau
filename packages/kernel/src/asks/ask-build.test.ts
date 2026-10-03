import type { AskOption, AskQuestion } from '@bytebureau/protocol'
import { describe, expect, it } from 'vitest'
import {
  buildAsk,
  DENY_ON_TIMEOUT_MESSAGE,
  recommendedAnswer,
  timeoutAnswer,
  timeoutMs,
  type OpenAskInput,
} from './ask-build.js'
import { question, request } from './ask-fixtures.js'

const build = (overrides: Partial<OpenAskInput> = {}): ReturnType<typeof buildAsk> =>
  buildAsk(request('s1', overrides))

const statusCall = { name: 'Bash', input: { command: 'git status' } }

const option = (id: string, recommended: boolean): AskOption => ({
  id,
  label: id,
  recommended,
  evidence: [],
})

const asking = (id: string, options: readonly AskOption[]): AskQuestion => ({
  ...question,
  id,
  options,
})

describe(buildAsk, () => {
  it.each([
    ['supervised', 'question', 'wait'],
    ['supervised', 'permission', 'wait'],
    ['autonomous', 'question', 'recommended'],
    ['autonomous', 'permission', 'deny'],
    ['yolo', 'question', 'recommended'],
    ['yolo', 'permission', 'deny'],
  ] as const)('%s employee, %s ask: the policy is %s', (permissionMode, kind, onTimeout) => {
    const { policy } = build({ permissionMode, kind })
    expect(policy).toStrictEqual({ onTimeout, timeout: '30m' })
  })

  it('puts the deadline one timeout after creation and none on an ask that waits', () => {
    const timed = build({ permissionMode: 'autonomous' })
    const expected = new Date(Date.parse(timed.createdAt) + 1_800_000).toISOString()
    expect(timed.deadlineAt).toBe(expected)
    expect(build().deadlineAt).toBeNull()
  })

  it('starts out pending with an id of its own and the turn it was given', () => {
    const first = build({ turnId: 't1' })
    expect(first).toMatchObject({
      sessionId: 's1',
      turnId: 't1',
      status: 'pending',
      title: 'Choose',
    })
    expect(build().id).not.toBe(first.id)
  })

  it('keeps the recommendation of the agent, or none when no option carries one', () => {
    const bare = asking('q1', [option('a', false), option('b', false)])
    expect(build().recommendationSource).toBe('agent')
    expect(build({ recommendationSource: 'none' }).recommendationSource).toBe('none')
    expect(build({ questions: [bare] }).recommendationSource).toBe('none')
  })

  it('assumes the agent made the recommendation when nobody says who did', () => {
    expect(build({ recommendationSource: undefined }).recommendationSource).toBe('agent')
  })
})

describe('buildAsk for a permission', () => {
  it('derives the options of a permission ask from the rules, whatever questions came along', () => {
    const ask = build({ kind: 'permission', toolCall: statusCall })
    expect(ask.recommendationSource).toBe('policy')
    expect(ask.questions).toStrictEqual([
      {
        id: 'permission',
        header: 'Permission',
        prompt: 'Bash: allow this tool call?',
        options: [
          {
            id: 'allow',
            label: 'Allow',
            recommended: true,
            evidence: [{ kind: 'rule', ref: 'read-only-command' }],
          },
          { id: 'deny', label: 'Deny', recommended: false, evidence: [] },
        ],
        multiSelect: false,
        allowOther: false,
      },
    ])
  })

  it('recommends nothing for a tool call no rule knows', () => {
    const ask = build({ kind: 'permission', toolCall: { name: 'Mystery', input: {} } })
    const options = ask.questions.flatMap((entry) => entry.options)
    expect(ask.recommendationSource).toBe('none')
    expect(options.map((entry) => [entry.id, entry.recommended])).toStrictEqual([
      ['allow', false],
      ['deny', false],
    ])
  })

  it('keeps the questions of a permission ask that has no tool call', () => {
    const ask = build({ kind: 'permission', questions: [question] })
    expect(ask.questions).toStrictEqual([question])
    expect(ask.recommendationSource).toBe('agent')
    expect(ask).not.toHaveProperty('toolCall')
  })

  it('carries the tool call of a question ask without reading it', () => {
    const ask = build({ toolCall: statusCall })
    expect(ask.toolCall).toStrictEqual(statusCall)
    expect(ask.questions).toStrictEqual([question])
  })
})

describe(timeoutMs, () => {
  it('is the timeout of a policy that acts and none for one that waits', () => {
    expect(timeoutMs({ onTimeout: 'recommended', timeout: '5m' })).toBe(300_000)
    expect(timeoutMs({ onTimeout: 'wait', timeout: 'whenever' })).toBeNull()
  })

  it('refuses a timeout it cannot read when the policy acts', () => {
    expect(() => build({ permissionMode: 'autonomous', askTimeout: '1x' })).toThrow(
      'invalid duration: 1x',
    )
  })

  it('never reads the timeout of an ask that waits', () => {
    const ask = build({ permissionMode: 'supervised', askTimeout: 'whenever' })
    expect(ask.policy).toStrictEqual({ onTimeout: 'wait', timeout: 'whenever' })
  })
})

describe(recommendedAnswer, () => {
  it('picks the recommended option of every question, in order', () => {
    const second = asking('q2', [option('x', false), option('y', true)])
    expect(recommendedAnswer(build({ questions: [question, second] }))).toStrictEqual({
      selected: ['a', 'y'],
    })
  })

  it('picks an empty id for a question without a recommended option', () => {
    const bare = asking('q2', [option('x', false)])
    expect(recommendedAnswer(build({ questions: [question, bare] }))).toStrictEqual({
      selected: ['a', ''],
    })
  })
})

describe(timeoutAnswer, () => {
  it('denies with the documented message when the policy denies', () => {
    const ask = build({ permissionMode: 'autonomous', kind: 'permission', toolCall: statusCall })
    expect(timeoutAnswer(ask)).toStrictEqual({
      selected: ['deny'],
      otherText: DENY_ON_TIMEOUT_MESSAGE,
    })
    expect(DENY_ON_TIMEOUT_MESSAGE).toBe('nobody available to approve; do not retry')
  })

  it('answers with the recommended options when the policy recommends', () => {
    expect(timeoutAnswer(build({ permissionMode: 'autonomous' }))).toStrictEqual({
      selected: ['a'],
    })
  })
})
