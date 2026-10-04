import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'api',
    include: ['src/**/*.test.ts'],
    // The node:sqlite module behind the in-memory store warns on Node; the warning is noise in test output
    execArgv: ['--disable-warning=ExperimentalWarning'],
    testTimeout: 20_000,
  },
})
