import { defineProject } from 'vitest/config'

export default defineProject({
  test: { name: 'bytebureau', include: ['src/**/*.test.ts'], testTimeout: 20_000 },
})
