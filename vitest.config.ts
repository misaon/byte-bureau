import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/i18n',
      'packages/protocol',
      'packages/plugin-api',
      'packages/kernel',
      'apps/bytebureau',
      'apps/docs',
      'scripts',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.ts',
        'scripts/**/*.ts',
        'apps/docs/scripts/**/*.ts',
        'apps/bytebureau/src/locale.ts',
        'apps/bytebureau/src/output.ts',
        'apps/bytebureau/src/run.ts',
      ],
      exclude: ['packages/i18n/src/paraglide/**', '**/*.test.ts'],
      thresholds: { lines: 80, branches: 80 },
      reporter: ['text', 'lcov'],
    },
  },
})
