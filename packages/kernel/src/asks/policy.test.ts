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
