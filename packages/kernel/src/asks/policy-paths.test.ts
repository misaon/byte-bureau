import { describe, expect, it } from 'vitest'
import { recommendForPermission, type PermissionRecommendation } from './policy.js'

const ws = '/repo/.bytebureau/worktrees/s1'

const NOTHING: PermissionRecommendation = { recommended: null, ruleId: null }

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
    ['Write', `${ws}/src/../src/a.ts`, 'in-workspace-edit'],
    ['Read', `${ws}/src/../src/a.ts`, 'in-workspace-read'],
    ['Write', 'src/a.ts', 'in-workspace-edit'],
    ['Read', 'src/a.ts', 'in-workspace-read'],
    ['Read', './src/a.ts', 'in-workspace-read'],
    ['Write', `${ws}//src/./a.ts`, 'in-workspace-edit'],
  ])('allows %s of %s once it is resolved', (name, filePath, ruleId) => {
    expect(touching(name, filePath)).toStrictEqual({ recommended: 'allow', ruleId })
  })

  it('resolves against a workspace that was written with a trailing slash', () => {
    expect(touching('Write', 'src/a.ts', `${ws}/`)).toStrictEqual({
      recommended: 'allow',
      ruleId: 'in-workspace-edit',
    })
  })
})

describe('recommendForPermission secrets behind a resolved path', () => {
  it('denies a secret outside the workspace that a traversal reaches', () => {
    expect(touching('Read', `${ws}/../other/.env`)).toStrictEqual({
      recommended: 'deny',
      ruleId: 'secrets-path',
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
    expect(touching('Read', filePath).ruleId).toBe('secrets-path')
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
    expect(touching('Read', '/home/me/.env', '').ruleId).toBe('secrets-path')
    expect(recommendForPermission(removal, '', 'supervised').ruleId).toBe('rm-outside-workspace')
  })
})
