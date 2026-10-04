import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/i18n',
      'packages/protocol',
      'packages/plugin-api',
      'packages/kernel',
      'packages/api',
      'packages/client',
      'plugins/workspace-local',
      'apps/bytebureau',
      'apps/docs',
      'scripts',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.ts',
        'plugins/*/src/**/*.ts',
        'scripts/**/*.ts',
        'apps/docs/scripts/**/*.ts',
        'apps/bytebureau/src/locale.ts',
        'apps/bytebureau/src/context.ts',
        'apps/bytebureau/src/output.ts',
        'apps/bytebureau/src/run.ts',
        'apps/bytebureau/src/errors.ts',
        'apps/bytebureau/src/kernel-home.ts',
        'apps/bytebureau/src/resource.ts',
        'apps/bytebureau/src/render/**/*.ts',
        'apps/bytebureau/src/commands/run-session.ts',
        'apps/bytebureau/src/commands/run-output.ts',
      ],
      exclude: ['packages/i18n/src/paraglide/**', '**/*.test.ts', '**/testing/**', '**/gen/**'],
      thresholds: { lines: 80, branches: 80 },
      reporter: ['text', 'lcov'],
    },
  },
})
