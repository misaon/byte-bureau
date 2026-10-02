import { defineCommand, type CommandDef } from 'citty'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { run } from './run.js'

interface Console {
  readonly log: MockInstance<typeof console.log>
  readonly error: MockInstance<typeof console.error>
}

function silenceConsole(): Console {
  return {
    log: vi.spyOn(console, 'log').mockReturnValue(),
    error: vi.spyOn(console, 'error').mockReturnValue(),
  }
}

function failingWith(error: unknown): CommandDef {
  return defineCommand({
    meta: { name: 'fake', description: 'Fake command' },
    run: vi.fn<() => Promise<void>>().mockRejectedValue(error),
  })
}

const parent = defineCommand({
  meta: { name: 'parent', version: '1.2.3', description: 'Parent command' },
  subCommands: {
    child: defineCommand({
      meta: { name: 'child', description: 'Child command' },
      run: vi.fn<() => void>(),
    }),
  },
})

describe(run, () => {
  it('returns 0 when the command succeeds', async () => {
    expect.hasAssertions()
    const succeed = vi.fn<() => void>()
    await expect(run(defineCommand({ run: succeed }), [])).resolves.toBe(0)
    expect(succeed).toHaveBeenCalledWith(expect.objectContaining({ rawArgs: [] }))
  })

  it('returns 1 and prints the usage for a CLIError', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    const command = failingWith(Object.assign(new Error('bad flag'), { name: 'CLIError' }))
    await expect(run(command, [])).resolves.toBe(1)
    expect(output.log).toHaveBeenCalledWith(expect.stringContaining('Fake command'))
    expect(output.error).toHaveBeenCalledWith('bad flag')
  })

  it('returns 1 for an unknown subcommand', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    await expect(run(parent, ['nope'])).resolves.toBe(1)
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('Unknown command'))
  })

  it('returns 2 and prints only the message for any other error', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    const command = failingWith(new Error('boom'))
    await expect(run(command, [])).resolves.toBe(2)
    expect(output.error).toHaveBeenCalledWith('boom')
    expect(output.log).not.toHaveBeenCalled()
  })

  it('returns 2 when a non-Error value is thrown', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    await expect(run(failingWith('oops'), [])).resolves.toBe(2)
    expect(output.error).toHaveBeenCalledWith('oops')
  })
})

describe('run built-in flags', () => {
  it('prints the usage of the named subcommand for --help', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    await expect(run(parent, ['child', '--help'])).resolves.toBe(0)
    expect(output.log).toHaveBeenCalledWith(expect.stringContaining('Child command'))
  })

  it('prints the version for --version and -v', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    await expect(run(parent, ['--version'])).resolves.toBe(0)
    await expect(run(parent, ['-v'])).resolves.toBe(0)
    expect(output.log).toHaveBeenNthCalledWith(1, '1.2.3')
    expect(output.log).toHaveBeenNthCalledWith(2, '1.2.3')
  })

  it('treats a missing version as a usage error', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    const command = defineCommand({ run: vi.fn<() => void>() })
    await expect(run(command, ['--version'])).resolves.toBe(1)
    expect(output.error).toHaveBeenCalledWith('No version specified')
  })
})
