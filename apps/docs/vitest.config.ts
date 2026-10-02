import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'docs', include: ['scripts/**/*.test.ts'] } })
