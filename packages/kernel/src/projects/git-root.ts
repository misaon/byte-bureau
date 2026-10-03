import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

function git(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

export const findGitRoot = (directory: string): string | null =>
  git(directory, ['rev-parse', '--show-toplevel'])

export const isByteBureauWorktree = (root: string): boolean =>
  existsSync(path.join(root, '.bytebureau-session.json'))

export function defaultBranchOf(root: string): string {
  const head = git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  return head === null ? 'main' : head.replace(/^origin\//u, '')
}
