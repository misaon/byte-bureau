import { readdirSync } from 'node:fs'
import type { UserConfig } from '@commitlint/types'

const workspaceDirs = ['apps', 'packages', 'plugins']

function directoriesIn(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

const scopes = [
  ...new Set([
    ...workspaceDirs.flatMap((directory) => directoriesIn(directory)),
    'cli',
    'deps',
    'release',
    'repo',
    'ci',
    'docs',
  ]),
]

const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert'],
    ],
    'scope-enum': [2, 'always', scopes],
    'body-max-line-length': [0, 'always', 0],
  },
}

export default config
