import { compile } from '@inlang/paraglide-js'

await compile({
  project: './project.inlang',
  outdir: './src/paraglide',
  strategy: ['globalVariable', 'baseLocale'],
  emitGitIgnore: false,
  emitPrettierIgnore: false,
  emitTsDeclarations: true,
})
