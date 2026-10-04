import { fileURLToPath } from 'node:url'
import { defineConfig } from 'eslint/config'
import jsdocPlugin from 'eslint-plugin-jsdoc'
import security from 'eslint-plugin-security'
import sonarjs from 'eslint-plugin-sonarjs'
import tseslint from 'typescript-eslint'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/paraglide/**',
      '**/.astro/**',
      '**/*.config.*',
      '**/src/gen/**',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: repoRoot },
    },
    plugins: { sonarjs, security },
    rules: {
      'sonarjs/cognitive-complexity': ['error', 15],
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-duplicate-string': ['error', { threshold: 5 }],
      'security/detect-eval-with-expression': 'error',
      'security/detect-unsafe-regex': 'error',
      'security/detect-child-process': 'error',
    },
  },
  {
    files: ['scripts/**/*.ts', '**/*.test.ts', 'apps/bytebureau/src/**/*.ts'],
    rules: { 'security/detect-child-process': 'off' },
  },
  {
    files: [
      'packages/plugin-api/src/**/*.ts',
      'packages/protocol/src/**/*.ts',
      'packages/client/src/**/*.ts',
    ],
    plugins: { jsdoc: jsdocPlugin },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: { FunctionDeclaration: true, ClassDeclaration: true, MethodDefinition: true },
        },
      ],
    },
  },
)
