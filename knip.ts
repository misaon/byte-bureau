import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  ignoreDependencies: [
    // Loaded by dependency-cruiser as its TypeScript parser (parser: 'swc' in its config)
    '@swc/core',
  ],
  // The root "release" script calls changelogen before it is installed
  // Remove this entry once changelogen is a devDependency
  // Then list changelog.config.ts in the root workspace entry as well
  ignoreBinaries: ['changelogen'],
  workspaces: {
    '.': { entry: ['scripts/*.ts'], project: ['scripts/**/*.ts'] },
    'apps/bytebureau': { project: ['src/**/*.ts'] },
    'apps/docs': {
      entry: ['scripts/*.ts'],
      project: ['src/**/*.{ts,mjs,astro,mdx}', 'scripts/**/*.ts'],
    },
    'packages/i18n': { project: ['src/**/*.ts', 'scripts/**/*.ts'] },
    'packages/tsconfig': { entry: [], project: [] },
  },
}

export default config
