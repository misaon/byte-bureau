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
import { createKeyedQueue } from './keyed-queue.js'
import { parseStatusV2 } from './status-parser.js'
import {
  copyIgnoredFiles,
  ensureExcluded,
  isDirectory,
  isSessionWorktree,
  onDisk,
  writeSessionMarker,
} from './worktree-files.js'

const MIN_GIT = [2, 40] as const
const FETCH_INTERVAL_MS = 60_000
// Untracked files count whatever status.showUntrackedFiles says
const STATUS = ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']

interface Placement {
  readonly projectPath: string
  readonly worktreePath: string
  readonly baseRef: string
}

interface WorktreeState {
  readonly dirty: boolean
  readonly branch: string
  readonly locked: boolean
}

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
  private readonly git: Git
  private readonly lastFetch = new Map<string, number>()
  private readonly enqueue = createKeyedQueue()

  public constructor(spawner: ProcessSpawner, logger: Logger) {
    this.spawner = spawner
    this.git = createGit(spawner, logger.child('git'))
  }

  public async provision(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
    const projectPath = await this.checkProject(spec.projectPath)
    await this.excludeFromGit(projectPath)
    const baseRef = await this.resolveBaseRef(projectPath, spec)
    const place = {
      projectPath,
      worktreePath: worktreePathOf(projectPath, spec.sessionId),
      baseRef,
    }
    // A main checkout and its linked worktrees share one queue: the branch names they pick from are the same
    const repository = await this.git.commonDir(projectPath)
    const branch = await this.enqueue(repository, async () => {
      const added = await this.addWorktree(place, spec.branch)
      return added
    })
    await this.populate(place, branch, spec)
    return { id: spec.sessionId, runtimeId: this.id, path: place.worktreePath, branch, baseRef }
  }

  public async exec(handle: WorkspaceHandle, spec: ExecSpec): Promise<ExecHandle> {
    const child = await this.spawner.spawn({ ...spec, cwd: handle.path })
    return child
  }

  public async status(handle: WorkspaceHandle): Promise<WorkspaceStatus> {
    const state = await this.worktreeState(handle)
    // `# branch.ab` exists only with an upstream; count against the base ref instead
    const range = `${handle.baseRef}...HEAD`
    const counts = await this.git.must(handle.path, ['rev-list', '--left-right', '--count', range])
    const [behind = '0', ahead = '0'] = counts.split('\t')
    const pushed = await this.git.onRemote(handle.path)
    return { ...state, ahead: Number(ahead), behind: Number(behind), pushed }
  }

  public async destroy(
    handle: WorkspaceHandle,
    options: { readonly force?: boolean } = {},
  ): Promise<void> {
    const state = await this.worktreeState(handle)
    if (state.locked) {
      throw new WorkspaceError('locked', `worktree ${handle.path} is locked`)
    }
    if (state.dirty && options.force !== true) {
      throw new WorkspaceError('dirty', `worktree ${handle.path} has uncommitted changes`)
    }
    const args = ['worktree', 'remove', ...(options.force === true ? ['--force'] : []), handle.path]
    await this.git.must(mainCheckoutOf(handle.path), args)
  }

  // What destroy needs to know, which unlike ahead and behind does not depend on the base ref
  private async worktreeState(handle: WorkspaceHandle): Promise<WorktreeState> {
    const parsed = parseStatusV2(await this.git.must(handle.path, STATUS))
    const locked = await this.git.worktreeLocked(handle.path, handle.path)
    return { dirty: parsed.dirty, branch: parsed.branch, locked }
  }

  private async checkProject(projectPath: string): Promise<string> {
    if (!isDirectory(projectPath)) {
      throw new WorkspaceError('not_a_repository', `${projectPath} is not a directory`)
    }
    await this.requireRecentGit(projectPath)
    const toplevel = await this.git.toplevel(projectPath)
    if (toplevel === null) {
      throw new WorkspaceError('not_a_repository', `${projectPath} is not inside a git repository`)
    }
    if (isSessionWorktree(toplevel)) {
      throw new WorkspaceError(
        'is_bytebureau_worktree',
        `${toplevel} is a ByteBureau session worktree`,
      )
    }
    return toplevel
  }

  // A git that cannot say which version it is counts as too old
  private async requireRecentGit(cwd: string): Promise<void> {
    const version = await this.gitVersion(cwd)
    if (versionTooOld(version)) {
      throw new WorkspaceError(
        'git_too_old',
        `git ${version.join('.')} found, ${MIN_GIT.join('.')} or newer is required`,
      )
    }
  }

  private async gitVersion(cwd: string): Promise<readonly [number, number]> {
    try {
      return await this.git.version(cwd)
    } catch {
      return [0, 0]
    }
  }

  private async resolveBaseRef(projectPath: string, spec: WorkspaceSpec): Promise<string> {
    if (!(await this.git.hasRemote(projectPath, 'origin'))) {
      return spec.baseBranch
    }
    await this.fetchThrottled(projectPath, spec.logger)
    const remoteRef = `origin/${spec.baseBranch}`
    return (await this.git.refExists(projectPath, remoteRef)) ? remoteRef : spec.baseBranch
  }

  private async fetchThrottled(projectPath: string, logger: Logger): Promise<void> {
    const last = this.lastFetch.get(projectPath) ?? 0
    if (Date.now() - last < FETCH_INTERVAL_MS) {
      return
    }
    this.lastFetch.set(projectPath, Date.now())
    const result = await this.git.run(projectPath, ['fetch', '--quiet', 'origin'])
    if (result.code !== 0) {
      logger.warn('git fetch failed; continuing with the last known refs', {
        stderr: result.stderr,
      })
    }
  }

  // Nobody else may take the branch name between picking it and adding the worktree
  private async addWorktree(place: Placement, wanted: string): Promise<string> {
    const branch = await this.freeBranch(place.projectPath, wanted)
    const args = ['worktree', 'add', '--no-track', place.worktreePath, '-b', branch, place.baseRef]
    await this.git.must(place.projectPath, args)
    return branch
  }

  // The exclude file belongs to the repository, so a project that is itself a linked worktree shares its main one
  private async excludeFromGit(projectPath: string): Promise<void> {
    const args = ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']
    const excludeFile = await this.git.must(projectPath, args)
    onDisk('updating the exclude list', () => {
      ensureExcluded(excludeFile)
    })
  }

  private async freeBranch(projectPath: string, wanted: string): Promise<string> {
    return firstFree(wanted, new Set(await this.git.localBranches(projectPath, wanted)))
  }

  // A failure here leaves no half-made worktree behind
  private async populate(place: Placement, branch: string, spec: WorkspaceSpec): Promise<void> {
    const { projectPath, baseRef } = place
    try {
      onDisk('preparing the worktree files', () => {
        copyIgnoredFiles(place, spec.copyIgnored, spec.logger)
        writeSessionMarker(place.worktreePath, {
          sessionId: spec.sessionId,
          projectPath,
          branch,
          baseRef,
        })
      })
    } catch (error) {
      await this.discard(place, branch, spec.logger)
      throw error
    }
  }

  // Taking back a failed provision is best effort: whatever goes wrong here, the caller gets the original error
  private async discard(place: Placement, branch: string, logger: Logger): Promise<void> {
    const leftover = { worktree: place.worktreePath, branch }
    try {
      const remove = ['worktree', 'remove', '--force', place.worktreePath]
      const removed = await this.git.run(place.projectPath, remove)
      const deleted = await this.git.run(place.projectPath, ['branch', '-D', branch])
      if (removed.code !== 0 || deleted.code !== 0) {
        logger.warn('could not take back a provision that failed', leftover)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn('could not take back a provision that failed', { ...leftover, reason })
    }
  }
}
