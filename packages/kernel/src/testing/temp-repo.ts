import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}

// Symlinks are resolved, as git reports paths: on macOS the temporary directory sits behind /var -> /private/var
// The directory is removed when the running test has finished
export function tempDir(prefix: string): string {
  const created = mkdtempSync(path.join(tmpdir(), prefix))
  const dir = realpathSync(created)
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function addOrigin(dir: string): void {
  const remote = tempDir('bb-remote-')
  git(remote, 'init', '-q', '--bare', '-b', 'main')
  git(dir, 'remote', 'add', 'origin', remote)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
}

// A repository with one commit on `main` and an optional bare "origin" remote
export function createTempRepo(options: { readonly withRemote?: boolean } = {}): string {
  const dir = tempDir('bb-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-q', '-m', 'initial')
  if (options.withRemote === true) {
    addOrigin(dir)
  }
  return dir
}
