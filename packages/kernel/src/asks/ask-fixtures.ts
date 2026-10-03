import { Ask, type AskOption, type AskQuestion } from '@bytebureau/protocol'
import { Schema } from 'effect'
import type { OpenAskInput } from './ask-build.js'

// One option the agent recommends and one it does not
export const question: AskQuestion = {
  id: 'q1',
  header: 'Approach',
  prompt: 'Which?',
  multiSelect: false,
  allowOther: true,
  options: [
    { id: 'a', label: 'A', recommended: true, evidence: [{ kind: 'test', ref: 'cli.test.ts' }] },
    { id: 'b', label: 'B', recommended: false, evidence: [] },
  ],
}

// An option without evidence
export const option = (id: string, recommended: boolean): AskOption => ({
  id,
  label: id,
  recommended,
  evidence: [],
})

// A question like the fixture one with other options
export const asking = (id: string, options: readonly AskOption[]): AskQuestion => ({
  ...question,
  id,
  options,
})

// A supervised question the agent has a recommendation for; a test overrides what it is about
export const request = (
  sessionId: string,
  overrides: Partial<OpenAskInput> = {},
): OpenAskInput => ({
  sessionId,
  turnId: null,
  kind: 'question',
  title: 'Choose',
  questions: [question],
  permissionMode: 'supervised',
  askTimeout: '30m',
  workspacePath: '/ws',
  recommendationSource: 'agent',
  ...overrides,
})

// The ask a record is made of: the record without what answering adds
export const askOf = Schema.decodeUnknownSync(Ask)
