import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { onTestFinished } from 'vitest'
import { registerScratch } from './sweep-homes.js'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
}

// Symlinks are resolved, as git reports paths: on macOS /var is a link to /private/var
// The directory is removed when the running test has finished, and swept at the end of the run should a daemon have come back to it
export function tempDir(prefix: string): string {
  const created = mkdtempSync(path.join(tmpdir(), prefix))
  const dir = realpathSync(created)
  registerScratch(dir)
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

// What every test home's config.json says: daemons on a free port, secrets in a file and never in the keychain of whoever runs the tests, bun trusted for the fake ACP agent
const TEST_CONFIG = {
  server: { port: 0 },
  secrets: { backend: 'file' },
  trust: { commands: ['bun'] },
}

// The config.json of a test home: the sections given in place of those of every test home, the others as they are
export function configureHome(
  home: string,
  sections: Readonly<Record<string, unknown>> = {},
): void {
  const config = { ...TEST_CONFIG, ...sections }
  writeFileSync(path.join(home, 'config.json'), `${JSON.stringify(config)}\n`)
}

// A home whose daemons listen on a free port and keep their secrets in a file, as every kernel of a test must
export function testHome(): string {
  const home = tempDir('bb-home-')
  configureHome(home)
  return home
}

// A file holding the token of a daemon named on the command line, removed when the test ends
export function tokenFile(token: string = 'a'.repeat(64)): string {
  const file = path.join(tempDir('bb-token-'), 'token')
  writeFileSync(file, `${token}\n`)
  return file
}

// A repository with one commit on `main`
export function createTempRepo(): string {
  const dir = tempDir('bb-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  git(dir, 'add', 'README.md')
  git(dir, 'commit', '-q', '-m', 'initial')
  return dir
}
