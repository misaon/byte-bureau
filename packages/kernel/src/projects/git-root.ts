import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { allowlistEnv } from '../process/env-allowlist.js'

const REMOTE_HEAD = 'refs/remotes/origin/'
// Where provisioning puts a worktree: a session worktree even after its marker is deleted
const PLACED = /[\\/]\.bytebureau[\\/]worktrees[\\/][^\\/]+$/u
const GIT_TIMEOUT_MS = 10_000

// Git sees the allowlisted environment, cannot prompt and cannot hang the kernel; only the final newline of its output goes
function git(cwd: string, args: readonly string[]): string | null {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...allowlistEnv(process.env), GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    })
    return output.replace(/\r?\n$/u, '')
  } catch {
    return null
  }
}

export const findGitRoot = (directory: string): string | null =>
  git(directory, ['rev-parse', '--show-toplevel'])

export const isByteBureauWorktree = (root: string): boolean =>
  PLACED.test(root) || existsSync(path.join(root, '.bytebureau-session.json'))

// The default branch is origin/HEAD read in full (a local branch named origin/main makes --short ambiguous), else the checked-out branch, else main
export function defaultBranchOf(root: string): string {
  const remoteHead = git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  if (remoteHead !== null && remoteHead.startsWith(REMOTE_HEAD)) {
    return remoteHead.slice(REMOTE_HEAD.length)
  }
  return git(root, ['symbolic-ref', '--short', 'HEAD']) ?? 'main'
}
