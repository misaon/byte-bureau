import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { jsonLines } from './json-lines.js'
import { runCli, type CliResult } from './run-cli.js'
import { createTempRepo, tempDir } from './temp-repo.js'

export const PROMPT = 'Create src/hello.ts exporting hello()'

export const ON_FAKE = ['--provider', 'fake']

// The flags of a run on the fake provider that reads like a script: events as JSON, every ask answered
export const FAKE = [...ON_FAKE, '--json', '--yes']

export interface Workbench {
  readonly repo: string
  // The home of the kernel, so its data of one test never meets another's
  readonly home: string
}

// A repository to work on and a home for the kernel, both removed when the test is over
export function workbench(): Workbench {
  return { repo: createTempRepo(), home: tempDir('bb-home-') }
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

// The id of the first project that `projects ls` tells of in the home
export async function projectIdIn(home: string): Promise<string> {
  const listed = await runCli(['projects', 'ls', '--json'], { BYTEBUREAU_HOME: home })
  const [record] = jsonLines(listed.stdout)
  const projects: unknown = record === undefined ? undefined : record['projects']
  const project: unknown = Array.isArray(projects) ? projects.at(0) : undefined
  const id: unknown =
    typeof project === 'object' && project !== null ? Reflect.get(project, 'id') : undefined
  if (typeof id !== 'string') {
    throw new TypeError(`no project in ${home}: ${listed.stdout}`)
  }
  return id
}
