import path from 'node:path'
import type {
  ExecHandle,
  ExecSpec,
  Logger,
  ProcessSpawner,
  WorkspaceHandle,
  WorkspaceRuntime,
  WorkspaceSpec,
  WorkspaceStatus,
} from '@bytebureau/plugin-api'
import { WorkspaceError } from './errors.js'
import { createGit, type Git } from './git.js'
import { parseStatusV2 } from './status-parser.js'
import {
  copyIgnoredFiles,
  ensureExcluded,
  hasSessionMarker,
  writeSessionMarker,
} from './worktree-files.js'

const MIN_GIT = [2, 40] as const
const FETCH_INTERVAL_MS = 60_000

function versionTooOld([major, minor]: readonly [number, number]): boolean {
  return major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])
}

// Worktrees sit in <project>/.bytebureau/worktrees/<session>, three levels below the main checkout
function worktreePathOf(projectPath: string, sessionId: string): string {
  return path.join(projectPath, '.bytebureau', 'worktrees', sessionId)
}

function mainCheckoutOf(worktreePath: string): string {
  return path.resolve(worktreePath, '..', '..', '..')
}

// The first of wanted, wanted-2, wanted-3, ... that no existing branch carries
function firstFree(wanted: string, taken: ReadonlySet<string>): string {
  let candidate = wanted
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${wanted}-${suffix}`
  }
  return candidate
}

export class LocalWorkspaceRuntime implements WorkspaceRuntime {
  public readonly id = 'local'
  public readonly isolation = 'none'
  private readonly spawner: ProcessSpawner
  private readonly logger: Logger
  private readonly git: Git
  private readonly lastFetch = new Map<string, number>()

  public constructor(spawner: ProcessSpawner, logger: Logger) {
    this.spawner = spawner
    this.logger = logger
    this.git = createGit(spawner, logger.child('git'))
  }

  public async provision(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
    const projectPath = await this.checkProject(spec.projectPath)
    await this.excludeFromGit(projectPath)
    const baseRef = await this.resolveBaseRef(projectPath, spec.baseBranch)
    const branch = await this.freeBranch(projectPath, spec.branch)
    const worktreePath = worktreePathOf(projectPath, spec.sessionId)
    await this.git.must(projectPath, ['worktree', 'add', worktreePath, '-b', branch, baseRef])
    copyIgnoredFiles({ projectPath, worktreePath }, spec.copyIgnored, this.logger)
    writeSessionMarker(worktreePath, { sessionId: spec.sessionId, projectPath, branch, baseRef })
    return { id: spec.sessionId, runtimeId: this.id, path: worktreePath, branch, baseRef }
  }

  public async exec(handle: WorkspaceHandle, spec: ExecSpec): Promise<ExecHandle> {
    const child = await this.spawner.spawn({ ...spec, cwd: handle.path })
    return child
  }

  public async status(handle: WorkspaceHandle): Promise<WorkspaceStatus> {
    const text = await this.git.must(handle.path, ['status', '--porcelain=v2', '--branch'])
    const parsed = parseStatusV2(text)
    // `# branch.ab` exists only with an upstream; count against the base ref instead
    const range = `${handle.baseRef}...HEAD`
    const counts = await this.git.must(handle.path, ['rev-list', '--left-right', '--count', range])
    const [behind = '0', ahead = '0'] = counts.split('\t')
    const locked = await this.git.worktreeLocked(handle.path, handle.path)
    return {
      dirty: parsed.dirty,
      branch: parsed.branch,
      ahead: Number(ahead),
      behind: Number(behind),
      locked,
    }
  }

  public async destroy(
    handle: WorkspaceHandle,
    options: { readonly force?: boolean } = {},
  ): Promise<void> {
    const status = await this.status(handle)
    if (status.locked) {
      throw new WorkspaceError('locked', `worktree ${handle.path} is locked`)
    }
    if (status.dirty && options.force !== true) {
      throw new WorkspaceError('dirty', `worktree ${handle.path} has uncommitted changes`)
    }
    const args = ['worktree', 'remove', ...(options.force === true ? ['--force'] : []), handle.path]
    await this.git.must(mainCheckoutOf(handle.path), args)
  }

  private async checkProject(projectPath: string): Promise<string> {
    const version = await this.gitVersion(projectPath)
    if (versionTooOld(version)) {
      throw new WorkspaceError(
        'git_too_old',
        `git ${version.join('.')} found, ${MIN_GIT.join('.')} or newer is required`,
      )
    }
    const toplevel = await this.git.toplevel(projectPath)
    if (toplevel === null) {
      throw new WorkspaceError('not_a_repository', `${projectPath} is not inside a git repository`)
    }
    if (hasSessionMarker(toplevel)) {
      throw new WorkspaceError(
        'is_bytebureau_worktree',
        `${toplevel} is a ByteBureau session worktree`,
      )
    }
    return toplevel
  }

  // A git that cannot say which version it is counts as too old
  private async gitVersion(cwd: string): Promise<readonly [number, number]> {
    try {
      return await this.git.version(cwd)
    } catch {
      return [0, 0]
    }
  }

  // The exclude file belongs to the repository, so a project that is itself a linked worktree shares its main one
  private async excludeFromGit(projectPath: string): Promise<void> {
    const args = ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']
    ensureExcluded(await this.git.must(projectPath, args))
  }

  private async resolveBaseRef(projectPath: string, baseBranch: string): Promise<string> {
    if (!(await this.git.hasRemote(projectPath, 'origin'))) {
      return baseBranch
    }
    await this.fetchThrottled(projectPath)
    const remoteRef = `origin/${baseBranch}`
    return (await this.git.refExists(projectPath, remoteRef)) ? remoteRef : baseBranch
  }

  private async fetchThrottled(projectPath: string): Promise<void> {
    const last = this.lastFetch.get(projectPath) ?? 0
    if (Date.now() - last < FETCH_INTERVAL_MS) {
      return
    }
    this.lastFetch.set(projectPath, Date.now())
    const result = await this.git.run(projectPath, ['fetch', '--quiet', 'origin'])
    if (result.code !== 0) {
      this.logger.warn('git fetch failed; continuing with the last known refs', {
        stderr: result.stderr,
      })
    }
  }

  private async freeBranch(projectPath: string, wanted: string): Promise<string> {
    return firstFree(wanted, new Set(await this.git.localBranches(projectPath, wanted)))
  }
}
