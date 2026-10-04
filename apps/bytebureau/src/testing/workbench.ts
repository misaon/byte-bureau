import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { firstId } from './json-lines.js'
import { runCli, type CliResult } from './run-cli.js'
import { createTempRepo, testHome } from './temp-repo.js'

export const PROMPT = 'Create src/hello.ts exporting hello()'

export const ON_FAKE = ['--provider', 'fake']

// The kernel in the process of the command, as before the daemon: the tests of the daemon spell their flags without it
export const NO_DAEMON = '--no-daemon'

// The flags of a run on the fake provider that reads like a script: events as JSON, every ask answered
// Without --no-daemon: a command with them talks to the daemon of the home
export const SCRIPTED = [...ON_FAKE, '--json', '--yes']

// The same, with the kernel in the process of the command
export const FAKE = [...SCRIPTED, NO_DAEMON]

export interface Workbench {
  readonly repo: string
  // The home of the kernel, so its data of one test never meets another's
  readonly home: string
}

// A repository to work on and a home for the kernel, both removed when the test is over
// A daemon started on demand for the home listens on a free port
export function workbench(): Workbench {
  return { repo: createTempRepo(), home: testHome() }
}

export function worktreesOf(repo: string): string {
  return path.join(repo, '.bytebureau', 'worktrees')
}

// The default employee of the repository works with the named provider, through its bytebureau.json
export function configureEmployeeProvider(repo: string, provider: string): void {
  const employee = { name: 'Developer', provider, model: 'any', permissionMode: 'supervised' }
  const config = {
    version: 1,
    project: { name: 'fixture' },
    employees: { developer: employee },
    defaults: { employee: 'developer' },
  }
  writeFileSync(path.join(repo, 'bytebureau.json'), JSON.stringify(config))
}

// A whole run of the fake agent on the workbench
export async function fakeRun({ repo, home }: Workbench, prompt = PROMPT): Promise<CliResult> {
  const result = await runCli(['run', prompt, '--project', repo, ...FAKE], {
    BYTEBUREAU_HOME: home,
  })
  return result
}

// The id of the first record that a listing command tells of in the home, asked in-process unless the flags say otherwise
async function firstIdOf(
  home: string,
  listing: { readonly command: readonly string[]; readonly key: string },
  flags: readonly string[],
): Promise<string> {
  const listed = await runCli([...listing.command, '--json', ...flags], { BYTEBUREAU_HOME: home })
  return firstId(listed.stdout, listing.key)
}

export async function projectIdIn(
  home: string,
  flags: readonly string[] = [NO_DAEMON],
): Promise<string> {
  const id = await firstIdOf(home, { command: ['projects', 'ls'], key: 'projects' }, flags)
  return id
}

export async function sessionIdIn(
  home: string,
  flags: readonly string[] = [NO_DAEMON],
): Promise<string> {
  const id = await firstIdOf(home, { command: ['sessions', 'ls'], key: 'sessions' }, flags)
  return id
}
