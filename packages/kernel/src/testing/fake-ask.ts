import type { Ask } from '@bytebureau/protocol'

// The one question of the hello script: a named export is recommended, with a rule as evidence
export const exportQuestion = (sessionId: string): Ask => ({
  id: `fake-ask-${sessionId}`,
  sessionId,
  turnId: null,
  kind: 'question',
  title: 'Export style',
  questions: [
    {
      id: 'style',
      header: 'Export',
      prompt: 'Should hello() be a named export?',
      multiSelect: false,
      allowOther: true,
      options: [
        {
          id: 'yes',
          label: 'Named export (Recommended)',
          description: 'Matches the existing modules',
          recommended: true,
          evidence: [{ kind: 'rule', ref: 'oxlint import/no-default-export' }],
        },
        { id: 'default', label: 'Default export', recommended: false, evidence: [] },
      ],
    },
  ],
  policy: { onTimeout: 'wait', timeout: '30m' },
  recommendationSource: 'agent',
  status: 'pending',
  createdAt: new Date().toISOString(),
  deadlineAt: null,
})
