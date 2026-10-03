import type { ExecHandle, Logger, ProcessSpawner } from '@bytebureau/plugin-api'
import { WorkspaceError } from './errors.js'

const BRANCHES = 'refs/heads/'
const VERSION = /(?<major>\d+)\.(?<minor>\d+)/u

interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  const parts: string[] = []
  for await (const line of stream) {
    parts.push(line)
  }
  return parts.join('\n')
}

async function settle(handle: ExecHandle): Promise<GitResult> {
  const [stdout, stderr, exit] = await Promise.all([
    collect(handle.stdout),
    collect(handle.stderr),
    handle.exited,
  ])
  return { code: exit.code ?? -1, stdout, stderr }
}

// The major and minor number of `git --version`; [0, 0] when the output holds no version
function parseVersion(text: string): readonly [number, number] {
  const match = VERSION.exec(text)
  if (match === null || match.groups === undefined) {
    return [0, 0]
  }
  return [Number(match.groups['major']), Number(match.groups['minor'])]
}

// `git worktree list --porcelain`: one block per worktree, the first line names its path
function isLocked(listing: string, worktreePath: string): boolean {
  const block = listing
    .split('\n\n')
    .find((entry) => entry.split('\n').includes(`worktree ${worktreePath}`))
  return block !== undefined && block.split('\n').some((line) => line.startsWith('locked'))
}

export interface Git {
  readonly run: (cwd: string, args: readonly string[]) => Promise<GitResult>
  readonly must: (cwd: string, args: readonly string[]) => Promise<string>
  readonly version: (cwd: string) => Promise<readonly [number, number]>
  readonly toplevel: (cwd: string) => Promise<string | null>
  readonly hasRemote: (cwd: string, name: string) => Promise<boolean>
  readonly refExists: (cwd: string, ref: string) => Promise<boolean>
  readonly localBranches: (cwd: string, prefix: string) => Promise<readonly string[]>
  readonly worktreeLocked: (cwd: string, worktreePath: string) => Promise<boolean>
  // The directory every worktree of the repository shares, absolute
  readonly commonDir: (cwd: string) => Promise<string>
  // Whether a remote-tracking ref contains the commit HEAD points at
  readonly onRemote: (cwd: string) => Promise<boolean>
}

type Must = Git['must']

// What the repository as a whole says, whichever of its worktrees is asked
function repositoryQueries(must: Must): Pick<Git, 'commonDir' | 'onRemote'> {
  return {
    async commonDir(cwd) {
      const directory = await must(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      return directory
    },
    async onRemote(cwd) {
      const args = ['for-each-ref', '--contains', 'HEAD', '--format=%(refname)', 'refs/remotes']
      const refs = await must(cwd, args)
      return refs !== ''
    },
  }
}

export function createGit(spawn: ProcessSpawner, logger: Logger): Git {
  const run: Git['run'] = async (cwd, args) => {
    logger.debug('git', { cwd, args })
    const handle = await spawn.spawn({
      command: 'git',
      args,
      cwd,
      env: { GIT_TERMINAL_PROMPT: '0' },
    })
    return settle(handle)
  }
  const must: Git['must'] = async (cwd, args) => {
    const result = await run(cwd, args)
    if (result.code !== 0) {
      const reason = `git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`
      throw new WorkspaceError('git_failed', reason)
    }
    return result.stdout.trim()
  }
  return {
    run,
    must,
    async version(cwd) {
      return parseVersion(await must(cwd, ['--version']))
    },
    async toplevel(cwd) {
      const result = await run(cwd, ['rev-parse', '--show-toplevel'])
      return result.code === 0 ? result.stdout.trim() : null
    },
    async hasRemote(cwd, name) {
      const result = await run(cwd, ['remote', 'get-url', name])
      return result.code === 0
    },
    async refExists(cwd, ref) {
      const result = await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      return result.code === 0
    },
    async localBranches(cwd, prefix) {
      const refs = await must(cwd, ['for-each-ref', '--format=%(refname)', `${BRANCHES}${prefix}*`])
      return refs
        .split('\n')
        .filter((ref) => ref !== '')
        .map((ref) => ref.slice(BRANCHES.length))
    },
    async worktreeLocked(cwd, worktreePath) {
      return isLocked(await must(cwd, ['worktree', 'list', '--porcelain']), worktreePath)
    },
    ...repositoryQueries(must),
  }
}
