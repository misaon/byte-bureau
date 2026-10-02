/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          String.raw`\.d\.ts$`,
          String.raw`\.test\.ts$`,
          String.raw`\.config\.(ts|mjs|cjs)$`,
          String.raw`(^|/)\.[^/]+\.(js|cjs|mjs|ts)$`,
          // Entry-point scripts (run from package.json scripts or CI) are never imported by design
          String.raw`(^|/)scripts/`,
        ],
      },
      to: {},
    },
    {
      name: 'effect-only-in-core',
      severity: 'error',
      comment: 'Only packages/kernel, packages/api and packages/protocol may depend on Effect.',
      from: { path: '^(packages/(?!(kernel|api|protocol)/)|plugins/)' },
      // Bun's isolated linker resolves packages to node_modules/.bun/<name>@<version>/node_modules/
      // The pattern is therefore not anchored to the first node_modules segment
      to: { path: '(^|/)node_modules/(effect|@effect)/' },
    },
    {
      name: 'plugins-depend-only-on-contracts',
      severity: 'error',
      comment:
        'Plugins may import only @bytebureau/plugin-api and @bytebureau/protocol from the workspace.',
      from: { path: '^plugins/' },
      to: { path: '^packages/', pathNot: '^packages/(plugin-api|protocol)/' },
    },
    {
      name: 'nothing-imports-apps',
      severity: 'error',
      from: { path: '^(packages|plugins|scripts)/' },
      to: { path: '^apps/' },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules'] },
    // Excluded modules vanish from the graph, so node_modules must stay out of this list
    // Otherwise a rule that targets a third-party package (effect-only-in-core) could never match
    exclude: { path: ['dist', 'coverage', 'src/paraglide', String.raw`\.astro`] },
    // The TypeScript API of dependency-cruiser stops at typescript 6 and this repo uses 7
    // So swc parses the sources, and the "missing-typescript-transpiler" notice is expected
    // Once TypeScript 7 is supported, drop swc and this option; tsPreCompilationDeps takes over
    parser: 'swc',
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
