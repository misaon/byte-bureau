import { defineCommand, type CommandDef } from 'citty'
import { describe, expect, it, vi } from 'vitest'
import { globalArgs } from './context.js'
import { run, subCommandIndex } from './run.js'

const FLAGS = {
  json: { type: 'boolean' },
  lang: { type: 'string' },
  'log-level': { type: 'string' },
  mode: { type: 'string', alias: 'm' },
} as const

describe(subCommandIndex, () => {
  it.each([
    [[], -1],
    [['--json'], -1],
    [['hello'], 0],
    [['--json', 'hello'], 1],
    [['--lang', 'cs', 'hello'], 2],
    [['--lang=cs', 'hello'], 1],
    [['--log-level', 'debug', 'hello'], 2],
    [['--logLevel', 'debug', 'hello'], 2],
    [['-m', 'fast', 'hello'], 2],
    [['--unknown', 'hello'], 1],
    [['--json', '--', 'hello'], -1],
    [['--lang'], -1],
  ])('finds the sub-command as citty does, in %j at %d', (argv, index) => {
    expect(subCommandIndex(argv, FLAGS)).toBe(index)
  })
})

interface Given {
  readonly rawArgs: readonly string[]
  readonly json: boolean
  readonly lang: string | undefined
  readonly debug: string | undefined
  readonly prompt: string | undefined
}

interface Tree {
  readonly command: CommandDef
  // What `projects ls` was given
  readonly given: Given[]
  // What the root was given, when it ran itself
  readonly rooted: (readonly string[])[]
}

// The tree of bytebureau as it is built: a root with the global flags, which tells the status for a call with no sub-command
function tree(): Tree {
  const given: Given[] = []
  const rooted: (readonly string[])[] = []
  const ls = defineCommand({
    meta: { name: 'ls', description: 'List the projects of the bureau' },
    args: { ...globalArgs, prompt: { type: 'positional', required: false } },
    run({ rawArgs, args }) {
      given.push({
        rawArgs,
        json: args.json,
        lang: args.lang,
        debug: args.debug,
        prompt: args.prompt,
      })
    },
  })
  const projects = defineCommand({
    meta: { name: 'projects', description: 'Manage projects' },
    subCommands: { ls },
  })
  const command: CommandDef = {
    meta: { name: 'bb', description: 'Root' },
    args: { ...globalArgs },
    subCommands: { projects },
    run({ rawArgs, args }) {
      if (args._.length === 0) {
        rooted.push(rawArgs)
      }
    },
  }
  return { command, given, rooted }
}

describe('run with global flags before the sub-command', () => {
  it('hands a flag before the sub-command to the sub-command, which parses its flags', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await expect(run(command, ['--json', 'projects', 'ls'])).resolves.toBe(0)
    expect(given).toMatchObject([{ json: true, rawArgs: ['--json'] }])
  })

  it('skips the value of a flag that takes one to find the sub-command, and hands both on', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--lang', 'cs', 'projects', 'ls'])
    expect(given).toMatchObject([{ lang: 'cs', rawArgs: ['--lang', 'cs'] }])
  })

  it('keeps the flags of both sides, those from before the sub-command behind the rest', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--json', 'projects', 'ls', 'fix it', '--lang', 'cs'])
    expect(given).toMatchObject([
      { json: true, lang: 'cs', prompt: 'fix it', rawArgs: ['fix it', '--lang', 'cs', '--json'] },
    ])
  })

  it('keeps what follows -- behind the flags that move, since it is no flag', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--json', 'projects', 'ls', '--', '--debug'])
    expect(given).toMatchObject([
      { json: true, debug: undefined, rawArgs: ['--json', '--', '--debug'] },
    ])
  })

  it('takes a bare --debug before the sub-command for a flag with no value', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--debug', 'projects', 'ls'])
    expect(given).toMatchObject([{ debug: '', rawArgs: ['--debug='] }])
  })

  it('leaves a call with no sub-command to the root, and the arguments after a sub-command where they are', async () => {
    expect.hasAssertions()
    const { command, given, rooted } = tree()
    await run(command, ['--json'])
    await run(command, ['projects', 'ls', '--json'])
    expect(rooted).toStrictEqual([['--json']])
    expect(given).toMatchObject([{ rawArgs: ['--json'] }])
  })
})

describe('run and the usage of a sub-command that follows a flag with a value', () => {
  it('prints the usage of the sub-command, not of what the value of the flag names', async () => {
    expect.hasAssertions()
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const { command } = tree()
    await expect(run(command, ['--lang', 'cs', 'projects', '--help'])).resolves.toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('List the projects of the bureau'))
  })
})
