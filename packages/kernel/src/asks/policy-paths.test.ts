import { describe, expect, it } from 'vitest'
import { recommendForPermission, type PermissionRecommendation } from './policy.js'

const ws = '/repo/.bytebureau/worktrees/s1'

const NOTHING: PermissionRecommendation = { recommended: null, ruleId: null }
const EDIT = 'in-workspace-edit'
const SECRETS_RULE = 'secrets-path'

const touching = (name: string, filePath: string, workspace = ws): PermissionRecommendation =>
  recommendForPermission({ name, input: { file_path: filePath } }, workspace, 'supervised')

describe('recommendForPermission paths that leave the workspace', () => {
  it.each([
    ['Write', `${ws}/../../../etc/passwd`],
    ['Read', `${ws}/../../../etc/hosts`],
    ['Write', `${ws}/../../../../etc/passwd`],
    ['Read', `${ws}/../../../../etc/hosts`],
    ['Write', `${ws}/../s2/a.ts`],
    ['Write', '../x.txt'],
    ['Read', 'src/../../x.txt'],
  ])('recommends nothing for %s of %s', (name, filePath) => {
    expect(touching(name, filePath)).toStrictEqual(NOTHING)
  })

  it.each([[ws], [`${ws}/`], [`${ws}/.`], [`${ws}/src/..`]])(
    'recommends nothing for the workspace itself, written %s',
    (filePath) => {
      expect(touching('Write', filePath)).toStrictEqual(NOTHING)
    },
  )
})

describe('recommendForPermission paths inside the workspace', () => {
  it.each([
    ['Write', `${ws}/src/../src/a.ts`, EDIT],
    ['Read', `${ws}/src/../src/a.ts`, 'in-workspace-read'],
    ['Write', 'src/a.ts', EDIT],
    ['Read', 'src/a.ts', 'in-workspace-read'],
    ['Read', './src/a.ts', 'in-workspace-read'],
    ['Write', `${ws}//src/./a.ts`, EDIT],
  ])('allows %s of %s once it is resolved', (name, filePath, ruleId) => {
    expect(touching(name, filePath)).toStrictEqual({ recommended: 'allow', ruleId })
  })

  it('resolves against a workspace that was written with a trailing slash', () => {
    expect(touching('Write', 'src/a.ts', `${ws}/`)).toStrictEqual({
      recommended: 'allow',
      ruleId: EDIT,
    })
  })
})

describe('recommendForPermission secrets behind a resolved path', () => {
  it('denies a secret outside the workspace that a traversal reaches', () => {
    expect(touching('Read', `${ws}/../other/.env`)).toStrictEqual({
      recommended: 'deny',
      ruleId: SECRETS_RULE,
    })
  })

  it.each([
    [`${ws}/key.pem/.`],
    [`${ws}/certs/server.pem/`],
    [`${ws}/.env/`],
    [`${ws}/.npmrc/.`],
    [`${ws}/src/../.env.local`],
    ['src/../.env'],
  ])('denies the secret %s once the path is resolved', (filePath) => {
    expect(touching('Read', filePath).ruleId).toBe(SECRETS_RULE)
  })
})

describe('recommendForPermission without a workspace', () => {
  it.each([
    ['Write', '/etc/passwd'],
    ['Read', '/etc/hosts'],
    ['Write', 'src/a.ts'],
  ])('counts nothing as inside it: %s of %s', (name, filePath) => {
    expect(touching(name, filePath, '')).toStrictEqual(NOTHING)
  })

  it('still denies a secret and a recursive removal', () => {
    const removal = { name: 'Bash', input: { command: 'rm -rf /' } }
    expect(touching('Read', '/home/me/.env', '').ruleId).toBe(SECRETS_RULE)
    expect(recommendForPermission(removal, '', 'supervised').ruleId).toBe('rm-outside-workspace')
  })
})

const glob = (input: Record<string, string>): PermissionRecommendation =>
  recommendForPermission({ name: 'Glob', input }, ws, 'supervised')

describe('recommendForPermission globs whose braces, escapes or .. leave the workspace', () => {
  it.each([
    [{ pattern: '{../../..,src}/**' }],
    [{ pattern: '{..,src}/**' }],
    [{ pattern: '{src,{lib,..}}/*.ts' }],
    [{ pattern: '{/etc,src}/**' }],
    [{ pattern: '{.,.}./**' }],
    [{ pattern: 'src/**/../../../etc/*' }],
    [{ pattern: String.raw`\.\./**` }],
    [{ pattern: String.raw`\/etc/**` }],
    [{ pattern: '{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}' }],
  ])('recommends nothing for %o', (input) => {
    expect(glob(input)).toStrictEqual(NOTHING)
  })

  it.each([
    [{ pattern: 'src/{a,b}/*.ts' }],
    [{ pattern: '**/*.{ts,tsx}' }],
    [{ pattern: '{src,test}/**', path: 'packages' }],
    [{ pattern: '{a}/{b,c}/*' }],
    [{ pattern: 'src/{a,b' }],
  ])('allows %o, which stays inside', (input) => {
    expect(glob(input)).toStrictEqual({ recommended: 'allow', ruleId: EDIT })
  })

  it('denies the secret one of its braces names', () => {
    expect(glob({ pattern: '**/.{env,npmrc}' })).toStrictEqual({
      recommended: 'deny',
      ruleId: SECRETS_RULE,
    })
  })
})

describe('recommendForPermission file tool paths that start with ~', () => {
  it.each([
    ['Read', '~/notes.txt'],
    ['Write', '~/x'],
    ['Edit', '~'],
  ])('recommends nothing for %s of %s, which a tool may expand', (name, filePath) => {
    expect(touching(name, filePath)).toStrictEqual(NOTHING)
  })

  it('still denies the secret behind ~', () => {
    expect(touching('Read', '~/.ssh/id_rsa')).toStrictEqual({
      recommended: 'deny',
      ruleId: SECRETS_RULE,
    })
  })

  it.each([
    [{ pattern: '*', path: '~' }],
    [{ pattern: '*.md', path: '~/notes' }],
    [{ pattern: '~/notes/*' }],
    [{ pattern: '{~,src}/*' }],
  ])('recommends nothing for a glob from ~: %o', (input) => {
    expect(glob(input)).toStrictEqual(NOTHING)
  })

  it('allows a path that merely holds a ~ further on', () => {
    expect(touching('Read', 'src/~backup.ts')).toStrictEqual({
      recommended: 'allow',
      ruleId: 'in-workspace-read',
    })
  })
})
