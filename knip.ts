import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  ignore: ['packages/i18n/src/paraglide/**', 'docs/**', 'tools/**'],
  ignoreDependencies: [
    '@tsconfig/strictest',
    'oxlint-tsgolint',
    '@types/bun',
    '@cspell/dict-cs-cz',
    // Loaded by dependency-cruiser as its TypeScript parser (parser: 'swc' in its config)
    '@swc/core',
  ],
  // The root "release" script calls changelogen before it is installed
  // Remove this entry once changelogen is a devDependency
  ignoreBinaries: ['changelogen'],
  workspaces: {
    '.': {
      entry: [
        'scripts/*.ts',
        'vitest.config.ts',
        'commitlint.config.ts',
        'changelog.config.ts',
        'knip.ts',
      ],
      project: ['scripts/**/*.ts'],
    },
    'apps/bytebureau': { entry: ['src/main.ts'], project: ['src/**/*.ts'] },
    'packages/i18n': {
      entry: ['src/index.ts', 'scripts/compile.ts'],
      project: ['src/**/*.ts', 'scripts/**/*.ts'],
    },
    'packages/tsconfig': { entry: [], project: [] },
  },
}

export default config
