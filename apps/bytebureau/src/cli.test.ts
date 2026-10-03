import { describe, expect, it } from 'vitest'
import { runCli } from './testing/run-cli.js'

const ESCAPE = '\u001B'

describe('bytebureau CLI', () => {
  it('prints a semantic version', async () => {
    expect.hasAssertions()
    const { stdout, code } = await runCli(['--version'])
    expect(code).toBe(0)
    expect(stdout).toMatch(/\d+\.\d+\.\d+/u)
  })

  it('lists the hello command in help', async () => {
    expect.hasAssertions()
    const { stdout, code } = await runCli(['--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('hello')
  })

  it('lists the kernel commands in help', async () => {
    expect.hasAssertions()
    const { stdout } = await runCli(['--help'])
    expect(stdout).toContain('run')
    expect(stdout).toContain('config')
    expect(stdout).toContain('projects')
    expect(stdout).toContain('workspaces')
  })
})

describe('bytebureau hello', () => {
  it('greets in Czech when --lang cs is passed', async () => {
    expect.hasAssertions()
    const { stdout, code } = await runCli(['hello', 'Ondřej', '--lang', 'cs'])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('Ahoj, Ondřej! ByteBureau je připraveno.')
  })

  it('greets anonymously in English by default', async () => {
    expect.hasAssertions()
    const { stdout } = await runCli(['hello'])
    expect(stdout.trim()).toBe('Hello! ByteBureau is ready.')
  })

  it('emits JSON without ANSI codes even when FORCE_COLOR is set', async () => {
    expect.hasAssertions()
    const { stdout } = await runCli(['hello', 'Ondřej', '--json'], { FORCE_COLOR: '1' })
    expect(stdout).not.toContain(ESCAPE)
    expect(JSON.parse(stdout)).toStrictEqual({
      command: 'hello',
      message: 'Hello, Ondřej! ByteBureau is ready.',
    })
  })

  it('falls back to English with a warning for an unsupported language', async () => {
    expect.hasAssertions()
    const { stdout, stderr, code } = await runCli(['hello', '--lang', 'de'])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('Hello! ByteBureau is ready.')
    expect(stderr).toContain('Unsupported language "de"')
  })

  it('exits with code 1 for an unknown command', async () => {
    expect.hasAssertions()
    const { code } = await runCli(['nonsense'])
    expect(code).toBe(1)
  })
})

describe('bytebureau global flags', () => {
  it('shows --log-level, as it is typed, in the help of a command', async () => {
    expect.hasAssertions()
    const { stdout } = await runCli(['run', '--help'])
    expect(stdout).toContain('--log-level')
    expect(stdout).not.toContain('--logLevel')
  })

  it('keeps a flag that follows a bare --debug a flag', async () => {
    expect.hasAssertions()
    const { stdout, code } = await runCli(['hello', '--debug', '--json'])
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toStrictEqual({
      command: 'hello',
      message: 'Hello! ByteBureau is ready.',
    })
  })
})
