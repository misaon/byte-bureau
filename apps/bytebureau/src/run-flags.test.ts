import { describe, expect, it, vi } from 'vitest'
import { run } from './run.js'
import { tree } from './testing/command-tree.js'

describe('run with a global flag before a command, at any level of the tree', () => {
  it('hands a flag before the sub-command to the sub-command, which parses its flags', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await expect(run(command, ['--json', 'projects', 'ls'])).resolves.toBe(0)
    expect(given).toMatchObject([{ command: 'ls', json: true, rawArgs: ['--json'] }])
  })

  it('hands a flag between a group and its leaf on to the leaf', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await expect(run(command, ['projects', '--json', 'ls'])).resolves.toBe(0)
    expect(given).toMatchObject([{ command: 'ls', json: true, rawArgs: ['--json'] }])
  })

  it('skips the values of the flags that take one to find the leaf, and hands both on', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['projects', '--host', 'H', '--port', 'P', 'ls'])
    expect(given).toMatchObject([{ host: 'H', port: 'P', rawArgs: ['--host', 'H', '--port', 'P'] }])
  })
})

describe('run with the flags of the levels above a leaf and the flags of the leaf', () => {
  it('keeps the flags of every level before what the leaf is given itself', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--json', 'projects', '--lang', 'cs', 'ls', 'fix it'])
    expect(given).toMatchObject([
      {
        json: true,
        lang: 'cs',
        positional: 'fix it',
        rawArgs: ['--json', '--lang', 'cs', 'fix it'],
      },
    ])
  })

  it('lets the flag that comes later win, which is the one the leaf was given itself', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--lang', 'cs', 'hello', '--lang', 'en'])
    expect(given).toMatchObject([{ command: 'hello', lang: 'en' }])
  })

  it('keeps a flag of the leaf that has no value from taking the flag that moved for its value', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--json', 'ask', 'answer', 'a1', '--other'])
    expect(given).toMatchObject([{ command: 'answer', json: true, positional: 'a1', other: '' }])
  })
})

describe('run with a -- or a bare --debug among the arguments', () => {
  it('keeps what follows -- behind the flags that move, since it is no flag', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--json', 'projects', 'ls', '--', '--debug'])
    expect(given).toMatchObject([
      { json: true, debug: undefined, rawArgs: ['--json', '--', '--debug'] },
    ])
  })

  it('reads no sub-command behind a --, so none runs', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await expect(run(command, ['--json', '--', 'projects', 'ls'])).resolves.toBe(0)
    expect(given).toStrictEqual([])
  })

  it('takes a bare --debug before the sub-command for a flag with no value', async () => {
    expect.hasAssertions()
    const { command, given } = tree()
    await run(command, ['--debug', 'projects', 'ls'])
    expect(given).toMatchObject([{ debug: '', rawArgs: ['--debug='] }])
  })
})

describe('run with a call that has no leaf or no sub-command', () => {
  it('leaves a call with no sub-command to the root, and the arguments after a leaf where they are', async () => {
    expect.hasAssertions()
    const { command, given, rooted } = tree()
    await run(command, ['--json'])
    await run(command, ['projects', 'ls', '--json'])
    expect(rooted).toStrictEqual([['--json']])
    expect(given).toMatchObject([{ rawArgs: ['--json'] }])
  })

  it('leaves a group with no leaf to its own usage, as a usage error', async () => {
    expect.hasAssertions()
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const error = vi.spyOn(console, 'error').mockReturnValue()
    const { command } = tree()
    await expect(run(command, ['--json', 'projects'])).resolves.toBe(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('List the projects of the bureau'))
    expect(error).toHaveBeenCalledWith(expect.stringContaining('No command specified'))
  })
})

describe('run and the usage of a command named after a flag with a value', () => {
  it.each([
    ['--lang', 'cs', 'projects', '--help'],
    ['--debug', 'projects', '--help'],
    ['projects', '--lang', 'cs', '--help'],
  ])('prints the usage of the group, not of what the value names: %j', async (...argv) => {
    expect.hasAssertions()
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const { command } = tree()
    await expect(run(command, argv)).resolves.toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('List the projects of the bureau'))
  })

  it('prints the usage of the root for a name only the prototype of an object has', async () => {
    expect.hasAssertions()
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const { command } = tree()
    await expect(run(command, ['constructor', '--help'])).resolves.toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Greet'))
  })

  it('prints the usage of the leaf after the flags of a group and of the root', async () => {
    expect.hasAssertions()
    const log = vi.spyOn(console, 'log').mockReturnValue()
    const { command } = tree()
    await expect(
      run(command, ['--json', 'projects', '--lang', 'cs', 'ls', '--help']),
    ).resolves.toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('PROMPT'))
  })
})
