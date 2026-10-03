import { Ask, type AskQuestion } from '@bytebureau/protocol'
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
