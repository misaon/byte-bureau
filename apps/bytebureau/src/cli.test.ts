import { execFileSync, spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const cwd = new URL('..', import.meta.url).pathname
const baseEnv = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  LANG: 'en_US.UTF-8',
}
const ESCAPE = '\u001B'

function run(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('bun', ['run', 'src/main.ts', ...args], {
    cwd,
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
  })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 }
}

describe('bytebureau CLI', () => {
  it('prints a semantic version', () => {
    const stdout = execFileSync('bun', ['run', 'src/main.ts', '--version'], {
      cwd,
      env: baseEnv,
      encoding: 'utf8',
    })
    expect(stdout).toMatch(/\d+\.\d+\.\d+/u)
  })

  it('lists the hello command in help', () => {
    const { stdout, status } = run(['--help'])
    expect(status).toBe(0)
    expect(stdout).toContain('hello')
  })

  it('greets in Czech when --lang cs is passed', () => {
    const { stdout, status } = run(['hello', 'Ondřej', '--lang', 'cs'])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('Ahoj, Ondřej! ByteBureau je připraveno.')
  })

  it('greets anonymously in English by default', () => {
    expect(run(['hello']).stdout.trim()).toBe('Hello! ByteBureau is ready.')
  })

  it('emits JSON without ANSI codes even when FORCE_COLOR is set', () => {
    const { stdout } = run(['hello', 'Ondřej', '--json'], { FORCE_COLOR: '1' })
    expect(stdout).not.toContain(ESCAPE)
    expect(JSON.parse(stdout)).toStrictEqual({
      command: 'hello',
      message: 'Hello, Ondřej! ByteBureau is ready.',
    })
  })

  it('falls back to English with a warning for an unsupported language', () => {
    const { stdout, stderr, status } = run(['hello', '--lang', 'de'])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('Hello! ByteBureau is ready.')
    expect(stderr).toContain('Unsupported language "de"')
  })

  it('exits with code 1 for an unknown command', () => {
    expect(run(['nonsense']).status).toBe(1)
  })
})
