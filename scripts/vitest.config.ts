import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'scripts',
    include: ['*.test.ts'],
    restoreMocks: true,
    // The smoke test runs a daemon and the CLI from source in Bun subprocesses
    testTimeout: 60_000,
  },
})
