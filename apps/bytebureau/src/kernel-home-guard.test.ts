import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { registerScratch } from './testing/sweep-homes.js'
import { tempDir } from './testing/temp-repo.js'

const CLI_DIRECTORY = fileURLToPath(new URL('..', import.meta.url))

interface Refusal {
  readonly code: number | null
  readonly stderr: string
  // Whether anything reached the home of the user
  readonly written: boolean
}

// HOME is a throwaway directory: a guard that let the empty variable through would write there, never into a real home
function runOnEmptyHome(args: readonly string[]): Refusal {
  const userHome = tempDir('bb-user-')
  const fallback = path.join(userHome, '.bytebureau')
  registerScratch(fallback)
  const result = spawnSync('bun', ['run', 'src/main.ts', ...args], {
    cwd: CLI_DIRECTORY,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: userHome,
      LANG: 'en_US.UTF-8',
      BYTEBUREAU_HOME: '',
    },
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
  })
  return { code: result.status, stderr: result.stderr, written: existsSync(fallback) }
}

describe('an empty BYTEBUREAU_HOME', () => {
  it('is refused by a command with exit code 2, naming the variable, before anything is written', () => {
    const refusal = runOnEmptyHome(['projects', 'ls', '--no-daemon'])
    expect([refusal.code, refusal.written]).toStrictEqual([2, false])
    expect(refusal.stderr).toContain('BYTEBUREAU_HOME is set but empty')
  })

  it('is refused by the daemon with exit code 2, naming the variable, before anything is written', () => {
    const refusal = runOnEmptyHome(['serve', '--no-daemonize', '--port', '0'])
    expect([refusal.code, refusal.written]).toStrictEqual([2, false])
    expect(refusal.stderr).toContain('BYTEBUREAU_HOME is set but empty')
  })

  it('is refused by config init with exit code 2, naming the variable, before it writes the project file', () => {
    const project = tempDir('bb-project-')
    const refusal = runOnEmptyHome(['config', 'init', '--project', project])
    const created = existsSync(path.join(project, 'bytebureau.jsonc'))
    expect([refusal.code, refusal.written, created]).toStrictEqual([2, false, false])
    expect(refusal.stderr).toContain('BYTEBUREAU_HOME is set but empty')
  })
})
