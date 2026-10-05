import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'agent-acp', include: ['src/**/*.test.ts'], testTimeout: 30_000 },
})
