import { describe, expect, it } from 'vitest'
import { AskBroker } from './asks.js'

// The input of AskUserQuestion as the SDK declares it: questions with a header, two to four options and multiSelect
const exportQuestion = {
  questions: [
    {
      question: 'Which export?',
      header: 'Export',
      options: [
        { label: 'Named (Recommended)', description: 'Matches the modules' },
        { label: 'Default', description: '' },
      ],
      multiSelect: false,
    },
  ],
}

const EXPORT_ASK = {
  type: 'ask.requested',
  ask: {
    id: 'req-1',
    kind: 'question',
    recommendationSource: 'agent',
    questions: [
      {
        id: '0',
        header: 'Export',
        options: [
          { id: 'Named (Recommended)', label: 'Named', recommended: true },
          { id: 'Default', label: 'Default', recommended: false },
        ],
      },
    ],
  },
}

const BASH_ASK = {
  ask: {
    kind: 'permission',
    title: 'Bash',
    toolCall: { name: 'Bash', input: { command: 'rm -rf dist' } },
    recommendationSource: 'none',
  },
}

describe('the asks of a permission prompt', () => {
  it('turns AskUserQuestion into a question ask with the recommended option found by its suffix, and answers the SDK with the labels', async () => {
    expect.hasAssertions()
    const broker = new AskBroker()
    const ids = { requestId: 'req-1', toolUseID: 'toolu_9' }
    const pending = broker.ask('AskUserQuestion', exportQuestion, ids)
    const [requested] = broker.drain()
    expect(requested).toMatchObject(EXPORT_ASK)
    broker.answer('req-1', { selected: ['Named (Recommended)'] })
    await expect(pending).resolves.toStrictEqual({
      behavior: 'allow',
      updatedInput: { questions: exportQuestion.questions, answers: { 'Which export?': 'Named' } },
    })
  })

  it('turns any other tool into a permission ask the kernel recommends on, and allows or denies by the answer', async () => {
    expect.hasAssertions()
    const broker = new AskBroker()
    const input = { command: 'rm -rf dist' }
    const allow = broker.ask('Bash', input, { requestId: 'req-2', toolUseID: 'toolu_2' })
    expect(broker.drain()).toMatchObject([BASH_ASK])
    broker.answer('req-2', { selected: ['allow'] })
    await expect(allow).resolves.toStrictEqual({ behavior: 'allow', updatedInput: input })
    const deny = broker.ask('Edit', {}, { requestId: 'req-3', toolUseID: 'toolu_3' })
    broker.answer('req-3', { selected: ['deny'] })
    await expect(deny).resolves.toStrictEqual({
      behavior: 'deny',
      message: 'denied through ByteBureau',
    })
  })

  it('denies everything that is pending on interrupt', async () => {
    expect.hasAssertions()
    const broker = new AskBroker()
    const hanging = broker.ask('Edit', {}, { requestId: 'req-4', toolUseID: 'toolu_4' })
    broker.denyAll('interrupted')
    await expect(hanging).resolves.toStrictEqual({ behavior: 'deny', message: 'interrupted' })
  })
})

const PENDING_QUESTION = {
  ask: {
    sessionId: 'session-1',
    title: 'Which export?',
    status: 'pending',
    turnId: null,
    deadlineAt: null,
    policy: { onTimeout: 'wait', timeout: '30m' },
  },
}

describe('the answers an ask passes on', () => {
  it('answers a question with the text of a person who chose none of the options', async () => {
    expect.hasAssertions()
    const broker = new AskBroker('session-1')
    const ids = { requestId: 'req-5', toolUseID: 'toolu_5' }
    const pending = broker.ask('AskUserQuestion', exportQuestion, ids)
    expect(broker.drain()).toMatchObject([PENDING_QUESTION])
    broker.answer('req-5', { selected: 'other', otherText: 'Both' })
    await expect(pending).resolves.toMatchObject({
      updatedInput: { answers: { 'Which export?': 'Both' } },
    })
  })

  it('denies with the reason the answer gives, as the kernel does when nobody approved in time', async () => {
    expect.hasAssertions()
    const broker = new AskBroker()
    const reason = 'nobody available to approve; do not retry'
    const ids = { requestId: 'req-6', toolUseID: 'toolu_6' }
    const pending = broker.ask('Bash', { command: 'ls' }, ids)
    broker.answer('req-6', { selected: ['deny'], otherText: reason })
    await expect(pending).resolves.toStrictEqual({ behavior: 'deny', message: reason })
  })
})

const UNMARKED = {
  questions: [
    {
      question: 'Which?',
      header: 'A very long header',
      options: [
        { label: 'A', description: 'a' },
        { label: 'B', description: 'b' },
      ],
      multiSelect: false,
    },
  ],
}

const UNMARKED_AND_MALFORMED = [
  { ask: { recommendationSource: 'none', questions: [{ header: 'A very long ' }] } },
  { ask: { kind: 'permission', title: 'AskUserQuestion' } },
]

describe('the questions an agent did not mark or could not ask', () => {
  it('recommends nothing when no option is marked, asks a malformed question as a permission, and ignores an answer to nothing', async () => {
    expect.hasAssertions()
    const broker = new AskBroker()
    const asked = broker.ask('AskUserQuestion', UNMARKED, {
      requestId: 'req-7',
      toolUseID: 'toolu_7',
    })
    const malformed = broker.ask(
      'AskUserQuestion',
      { questions: 'none' },
      { requestId: 'req-8', toolUseID: 'toolu_8' },
    )
    expect(broker.drain()).toMatchObject(UNMARKED_AND_MALFORMED)
    broker.answer('req-unknown', { selected: ['allow'] })
    broker.denyAll('closed')
    const closed = { behavior: 'deny', message: 'closed' }
    await expect(Promise.all([asked, malformed])).resolves.toStrictEqual([closed, closed])
  })
})
