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
      comment:
        'Only packages/kernel, packages/api and packages/protocol may depend on Effect; apps and plugins never do.',
      from: { path: '^(packages/(?!(kernel|api|protocol)/)|plugins/|apps/)' },
      // Bun's isolated linker resolves packages to node_modules/.bun/<name>@<version>/node_modules/
      // The pattern is therefore not anchored to the first node_modules segment
      // A package that does not declare effect cannot resolve it, so the bare name is matched as well
      to: { path: String.raw`(^|/)node_modules/(effect|@effect)/|^(effect|@effect/[^/]+)(/|$)` },
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
    // Excluded modules vanish from the graph, so these patterns must only match first-party paths
    // An unanchored "dist" once dropped third-party entry files such as citty, @clack/prompts and
    // Effect (node_modules/.bun/<name>@<version>/node_modules/<name>/dist/...)
    // With them went the edges that effect-only-in-core has to see
    // It also skipped first-party files whose names merely contain dist or coverage
    exclude: {
      path: [
        String.raw`^(apps|packages|plugins|scripts)/[^/]+/(dist|coverage)/`,
        'src/paraglide',
        String.raw`\.astro`,
      ],
    },
    // The TypeScript support of dependency-cruiser stops at typescript 6 and this repo uses 7
    // So swc parses the sources
    // Leave tsConfig and tsPreCompilationDeps unset: they only trigger a missing-typescript notice
    // Once TypeScript 7 is supported, drop swc and use parser: 'tsc' together with tsConfig
    parser: 'swc',
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
}
