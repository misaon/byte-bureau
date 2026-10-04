import { WorkspaceError } from '@bytebureau/kernel'
import { defineCommand, type CommandDef } from 'citty'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { DaemonRunningError } from './bureau/open-local.js'
import { globalArgs } from './context.js'
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

describe('run with a typed error of the kernel', () => {
  it('prints it as its name, its reason and its code, and returns 2', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    const error = new WorkspaceError({
      code: 'not_a_repository',
      reason: '/tmp/x is not inside a git repository',
    })
    await expect(run(failingWith(error), [])).resolves.toBe(2)
    expect(output.error).toHaveBeenCalledWith(
      'WorkspaceError: /tmp/x is not inside a git repository (not_a_repository)',
    )
  })
})

describe('run with --no-daemon beside a live daemon', () => {
  it('prints the way out without the usage, and returns 1', async () => {
    expect.hasAssertions()
    const output = silenceConsole()
    const refusal = new DaemonRunningError('A daemon is running on http://127.0.0.1:4747 (pid 42)')
    await expect(run(failingWith(refusal), [])).resolves.toBe(1)
    expect(output.error).toHaveBeenCalledWith(
      'A daemon is running on http://127.0.0.1:4747 (pid 42)',
    )
    expect(output.log).not.toHaveBeenCalled()
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

interface Given {
  readonly rawArgs: readonly string[]
  readonly json: boolean
  readonly debug: string | undefined
  readonly prompt: string | undefined
}

// `projects ls` with the global flags and a positional, telling what it was given
function listing(): { readonly command: CommandDef; readonly given: Given[] } {
  const given: Given[] = []
  const ls = defineCommand({
    meta: { name: 'ls', description: 'List' },
    args: { ...globalArgs, prompt: { type: 'positional', required: false } },
    run({ rawArgs, args }) {
      given.push({ rawArgs, json: args.json, debug: args.debug, prompt: args.prompt })
    },
  })
  const projects = defineCommand({ meta: { name: 'projects' }, subCommands: { ls } })
  return { command: defineCommand({ meta: { name: 'bb' }, subCommands: { projects } }), given }
}

describe('run with a bare --debug', () => {
  it('keeps the flag that follows it a flag, and debugs every category', async () => {
    expect.hasAssertions()
    const { command, given } = listing()
    await expect(run(command, ['projects', 'ls', '--debug', '--json'])).resolves.toBe(0)
    expect(given).toMatchObject([{ json: true, debug: '' }])
  })

  it('keeps the positional that follows it a positional', async () => {
    expect.hasAssertions()
    const { command, given } = listing()
    await run(command, ['projects', 'ls', '--debug', 'fix the build'])
    expect(given).toMatchObject([{ debug: '', prompt: 'fix the build' }])
  })

  it('leaves --debug=<categories> as it is', async () => {
    expect.hasAssertions()
    const { command, given } = listing()
    await run(command, ['projects', 'ls', '--debug=bb.core,!bb.store', '--json'])
    expect(given).toMatchObject([{ json: true, debug: 'bb.core,!bb.store' }])
  })

  it('leaves what follows -- alone, since it is no flag', async () => {
    expect.hasAssertions()
    const { command, given } = listing()
    await run(command, ['projects', 'ls', '--', '--debug'])
    expect(given).toMatchObject([{ rawArgs: ['--', '--debug'], debug: undefined }])
  })
})
