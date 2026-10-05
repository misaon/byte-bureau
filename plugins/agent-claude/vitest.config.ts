import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'agent-claude', include: ['src/**/*.test.ts'], testTimeout: 20_000 },
})
