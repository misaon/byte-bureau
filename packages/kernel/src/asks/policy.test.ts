import { describe, expect, it } from 'vitest'
import { parseDuration, recommendForPermission } from './policy.js'

const ws = '/repo/.bytebureau/worktrees/s1'

describe(recommendForPermission, () => {
  it.each([
    [{ name: 'Bash', input: { command: 'git status' } }, 'allow', 'read-only-command'],
    [{ name: 'Read', input: { file_path: `${ws}/src/a.ts` } }, 'allow', 'in-workspace-read'],
    [{ name: 'Write', input: { file_path: `${ws}/src/a.ts` } }, 'allow', 'in-workspace-edit'],
    [{ name: 'Bash', input: { command: 'git push --force origin main' } }, 'deny', 'force-push'],
    [{ name: 'Bash', input: { command: 'rm -rf /' } }, 'deny', 'rm-outside-workspace'],
    [{ name: 'Write', input: { file_path: `${ws}/.env` } }, 'deny', 'secrets-path'],
    [{ name: 'WebFetch', input: { url: 'https://x' } }, 'deny', 'network-in-supervised'],
    [{ name: 'Mystery', input: {} }, null, null],
  ] as const)('%o → %s (%s)', (toolCall, expected, rule) => {
    const result = recommendForPermission(toolCall, ws, 'supervised')
    expect(result.recommended).toBe(expected)
    expect(result.ruleId).toBe(rule)
  })

  it('does not treat network tools as deny-worthy for autonomous employees', () => {
    expect(
      recommendForPermission({ name: 'WebFetch', input: { url: 'https://x' } }, ws, 'autonomous')
        .recommended,
    ).toBeNull()
  })

  it('treats a yolo employee like an autonomous one', () => {
    const toolCall = { name: 'WebSearch', input: { query: 'effect' } }
    expect(recommendForPermission(toolCall, ws, 'yolo').recommended).toBeNull()
  })
})

const ruleOf = (name: string, input: unknown): string | null =>
  recommendForPermission({ name, input }, ws, 'supervised').ruleId

describe('recommendForPermission deny rules', () => {
  it.each([['git push -f origin main'], ['git push origin +main']])(
    'denies the force push %s',
    (command) => {
      expect(ruleOf('Bash', { command })).toBe('force-push')
    },
  )

  it('leaves an ordinary push to nobody', () => {
    expect(ruleOf('Bash', { command: 'git push origin main' })).toBeNull()
  })

  it.each([
    [`${ws}/.env.local`],
    [`${ws}/certs/server.pem`],
    [`${ws}/.npmrc`],
    ['/home/me/.netrc'],
    ['/home/me/id_rsa'],
    ['/home/me/id_ed25519'],
    ['/home/me/.ssh/config'],
  ])('denies the secrets path %s', (filePath) => {
    expect(ruleOf('Read', { file_path: filePath })).toBe('secrets-path')
  })

  it.each([[`${ws}/src/environment.ts`], [`${ws}/docs/pem.md`], [`${ws}/.envelope/a.txt`]])(
    'does not mistake %s for a secret',
    (filePath) => {
      expect(ruleOf('Write', { file_path: filePath })).toBe('in-workspace-edit')
    },
  )

  it('leaves a recursive removal inside the workspace to nobody', () => {
    expect(ruleOf('Bash', { command: `rm -rf ${ws}/build` })).toBeNull()
  })
})

describe('recommendForPermission allow rules', () => {
  it('reads the path field when a tool has no file_path', () => {
    expect(ruleOf('Read', { path: `${ws}/src/a.ts` })).toBe('in-workspace-read')
  })

  it('does not count a sibling of the workspace as part of it', () => {
    expect(ruleOf('Write', { file_path: `${ws}-copy/a.ts` })).toBeNull()
  })

  it('lets a deny rule win over an allow rule that matches too', () => {
    expect(ruleOf('Read', { file_path: `${ws}/.env` })).toBe('secrets-path')
  })
})

const shell = (command: string): ReturnType<typeof recommendForPermission> =>
  recommendForPermission({ name: 'Bash', input: { command } }, ws, 'supervised')

const ALLOWED = { recommended: 'allow', ruleId: 'read-only-command' }
const NOTHING = { recommended: null, ruleId: null }

describe('recommendForPermission read-only commands', () => {
  it.each([['git status'], ['git log --oneline -5'], ['rg foo src'], ['cat README.md']])(
    'allows the whole command %s',
    (command) => {
      expect(shell(command)).toStrictEqual(ALLOWED)
    },
  )

  it.each([
    ['ls'],
    ['ls -la src'],
    ['pwd'],
    ['echo hello world'],
    ['head -n 5 src/a.ts'],
    ['tail -n 20 build.log'],
    ['wc -l src/a.ts'],
    ['grep -rn foo src'],
    ['git diff HEAD~1'],
    ['git show HEAD'],
    ['git branch --list'],
    ['git rev-parse HEAD'],
  ])('allows %s as one of the read-only commands', (command) => {
    expect(shell(command)).toStrictEqual(ALLOWED)
  })

  it.each([['cat\tREADME.md'], ['git status '], ['ls  -la']])(
    'takes the space around its arguments: %j',
    (command) => {
      expect(shell(command)).toStrictEqual(ALLOWED)
    },
  )

  it('takes the commands of the list by their whole name only', () => {
    expect(shell('lsof -i')).toStrictEqual(NOTHING)
    expect(shell('ls.sh')).toStrictEqual(NOTHING)
    expect(shell('catalog x')).toStrictEqual(NOTHING)
    expect(shell('git statusbar')).toStrictEqual(NOTHING)
  })

  it('does not take a command that merely follows an assignment or a git option', () => {
    expect(shell('ls=1 touch f')).toStrictEqual(NOTHING)
    expect(shell('git -c core.pager=less log')).toStrictEqual(NOTHING)
  })
})

describe('recommendForPermission commands that do more than read', () => {
  it.each([
    ['find . -delete'],
    ['find . -name foo'],
    ['echo x > f'],
    ['echo x >> f'],
    ['cat < f'],
    ['cat f | sh'],
    ['ls ; touch f'],
    ['ls && touch f'],
    ['ls || touch f'],
    ['ls & touch f'],
    ['ls $(cat x)'],
    ['ls `cat x`'],
    ['cat <(ls)'],
    ['ls =(cat x)'],
  ])('recommends nothing for %s', (command) => {
    expect(shell(command)).toStrictEqual(NOTHING)
  })

  it.each([
    ['ls\ntouch f'],
    ['ls -la\ntouch f'],
    ['ls -la\r\ntouch f'],
    ['cat a.txt\rtouch f'],
    ['git status\n'],
    ['git status -s\n'],
  ])('recommends nothing for a line break anywhere: %j', (command) => {
    expect(shell(command)).toStrictEqual(NOTHING)
  })

  it('leaves a list that holds a removal to the deny rule before it', () => {
    expect(shell('git status; rm -rf /')).toStrictEqual({
      recommended: 'deny',
      ruleId: 'rm-outside-workspace',
    })
  })
})

describe('recommendForPermission input', () => {
  it.each([['text'], [null], [42], [{ command: 7 }], [{ file_path: null }]])(
    'finds no rule in the input %o',
    (input) => {
      const result = recommendForPermission({ name: 'Mystery', input }, ws, 'supervised')
      expect(result).toStrictEqual({ recommended: null, ruleId: null })
    },
  )
})

describe(parseDuration, () => {
  it('reads s, m, h suffixes', () => {
    expect(parseDuration('30m')).toBe(1_800_000)
    expect(parseDuration('45s')).toBe(45_000)
    expect(parseDuration('2h')).toBe(7_200_000)
  })

  it('reads milliseconds and zero', () => {
    expect(parseDuration('250ms')).toBe(250)
    expect(parseDuration('0s')).toBe(0)
  })

  it('ignores the space around and inside a duration', () => {
    expect(parseDuration(' 30m ')).toBe(1_800_000)
    expect(parseDuration('30 m')).toBe(1_800_000)
  })

  it.each([['1x'], [''], ['m'], ['30'], ['-5m'], ['1.5h'], ['30min'], ['1d']])(
    'refuses %j',
    (text) => {
      expect(() => parseDuration(text)).toThrow(`invalid duration: ${text}`)
    },
  )
})
