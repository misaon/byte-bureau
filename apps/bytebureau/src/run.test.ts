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

// The tagged errors of the kernel are Errors with an empty message
function typed(name: string, fields: Readonly<Record<string, unknown>>): Error {
  return Object.assign(new Error('placeholder'), { name, message: '' }, fields)
}

describe('run with the typed errors of the kernel', () => {
  it('prints the name, the reason and the code of an error with an empty message', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    const error = typed('WorkspaceError', {
      code: 'not_a_repository',
      reason: '/tmp/x is not inside a git repository',
    })
    await expect(run(failingWith(error), [])).resolves.toBe(2)
    expect(output.error).toHaveBeenCalledWith(
      'WorkspaceError: /tmp/x is not inside a git repository (not_a_repository)',
    )
  })

  it('names the file and the JSON pointer of a configuration error', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    const error = typed('ConfigError', {
      file: '/repo/bytebureau.json',
      pointer: '/employees/developer/model',
      reason: 'Expected a string',
    })
    await expect(run(failingWith(error), [])).resolves.toBe(2)
    expect(output.error).toHaveBeenCalledWith(
      'ConfigError: Expected a string (/repo/bytebureau.json/employees/developer/model)',
    )
  })

  it('names the file alone when a configuration error has no pointer', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    const error = typed('ConfigError', { file: '/repo/bytebureau.json', reason: 'both exist' })
    await run(failingWith(error), [])
    expect(output.error).toHaveBeenCalledWith('ConfigError: both exist (/repo/bytebureau.json)')
  })
})

describe('run with the typed errors of the kernel that name a cause or a kind', () => {
  it('prints the cause of a store error, and the kind of a provider error', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    const store = typed('StoreError', { cause: new Error('FOREIGN KEY constraint failed') })
    const provider = typed('ProviderError', { kind: 'auth', reason: 'not logged in' })
    await run(failingWith(store), [])
    await run(failingWith(provider), [])
    expect(output.error).toHaveBeenNthCalledWith(1, 'StoreError: FOREIGN KEY constraint failed')
    expect(output.error).toHaveBeenNthCalledWith(2, 'ProviderError: not logged in (auth)')
  })

  it('digs through the causes, whatever kind of value the innermost one is', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    const inner = typed('SqlError', { cause: 'disk full' })
    await run(failingWith(typed('StoreError', { cause: inner })), [])
    expect(output.error).toHaveBeenCalledWith('StoreError: SqlError: disk full')
  })

  it('adds what the errors behind a store error say, without telling the same twice', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    const sqlite = new Error('FOREIGN KEY constraint failed')
    const inner = new Error('Failed to execute statement', { cause: sqlite })
    const sql = new Error('Failed to execute statement', { cause: inner })
    await run(failingWith(typed('StoreError', { cause: sql })), [])
    expect(output.error).toHaveBeenCalledWith(
      'StoreError: Failed to execute statement: FOREIGN KEY constraint failed',
    )
  })

  it('prints the bare name of an error that has neither a message nor any fields', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    await run(failingWith(typed('AskError', {})), [])
    expect(output.error).toHaveBeenCalledWith('AskError')
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
