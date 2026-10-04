import type { CommandDef } from 'citty'
import { describe, expect, it } from 'vitest'
import { flagsAtLeaf, subCommandIndex } from './run.js'
import { tree } from './testing/command-tree.js'

const FLAGS = {
  json: { type: 'boolean' },
  lang: { type: 'string' },
  'log-level': { type: 'string' },
  mode: { type: 'string', alias: 'm' },
} as const

// The arguments of a line, which has no argument with a space in it
function words(line: string): string[] {
  return line === '' ? [] : line.split(' ')
}

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

describe(flagsAtLeaf, () => {
  it.each([
    ['', ''],
    ['--json', '--json'],
    ['hello', 'hello'],
    ['hello Ondřej --json', 'hello Ondřej --json'],
    ['--json hello', 'hello --json'],
    ['--lang cs hello --lang en', 'hello --lang cs --lang en'],
    ['projects --json ls', 'projects ls --json'],
    ['--json projects --lang cs ls x', 'projects ls --json --lang cs x'],
    ['projects --host H --port P ls', 'projects ls --host H --port P'],
    ['--json ask answer a1 --other', 'ask answer --json a1 --other'],
    ['projects', 'projects'],
    ['--json projects', 'projects --json'],
    ['--json nope', 'nope --json'],
    ['projects --lang cs nope', 'projects nope --lang cs'],
  ])('puts the flags of "%s" right behind the last name: "%s"', async (given, expected) => {
    expect.hasAssertions()
    await expect(flagsAtLeaf(tree().command, words(given))).resolves.toStrictEqual(words(expected))
  })
})

// A tree that gives its args, its sub-commands and its leaf lazily, as citty allows
function lazyTree(): CommandDef {
  const ls: CommandDef = { meta: { name: 'ls' }, args: { json: { type: 'boolean' } } }
  const group: CommandDef = { meta: { name: 'group' }, subCommands: () => ({ ls: () => ls }) }
  return {
    meta: { name: 'bb' },
    args: () => ({ lang: { type: 'string' } }),
    subCommands: () => ({ group }),
  }
}

describe('flagsAtLeaf and a tree given lazily', () => {
  it('walks the args and the sub-commands that are given as functions', async () => {
    expect.hasAssertions()
    const argv = words('--lang cs group --json ls x')
    await expect(flagsAtLeaf(lazyTree(), argv)).resolves.toStrictEqual(
      words('group ls --lang cs --json x'),
    )
  })
})

describe('flagsAtLeaf and a --', () => {
  it.each([
    ['--json -- hello', '--json -- hello'],
    ['hello -- --json', 'hello -- --json'],
    ['--json hello -- --lang cs', 'hello --json -- --lang cs'],
    ['projects -- ls', 'projects -- ls'],
    ['--json projects -- ls', 'projects --json -- ls'],
  ])(
    'moves nothing from behind a -- and reads no name there: "%s" into "%s"',
    async (given, expected) => {
      expect.hasAssertions()
      await expect(flagsAtLeaf(tree().command, words(given))).resolves.toStrictEqual(
        words(expected),
      )
    },
  )
})
