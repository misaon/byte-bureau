import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'bytebureau',
    include: ['src/**/*.test.ts'],
    // The local Bureau is tested over the in-memory store of the kernel, whose node:sqlite warns on Node; the warning is noise in test output
    execArgv: ['--disable-warning=ExperimentalWarning'],
    testTimeout: 20_000,
    restoreMocks: true,
    // Ends a daemon a test that timed out started after its cleanup, and removes the scratch homes of the run
    globalSetup: ['./src/testing/sweep.ts'],
  },
})
