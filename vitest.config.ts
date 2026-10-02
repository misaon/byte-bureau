import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/i18n', 'apps/bytebureau', 'apps/docs', 'scripts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/i18n/src/paraglide/**', '**/*.test.ts'],
      thresholds: { lines: 80, branches: 80 },
      reporter: ['text', 'lcov'],
    },
  },
})
