import { describe, expect, it } from 'vitest'
import { recommendForPermission, type PermissionRecommendation } from './policy.js'

const ws = '/repo/.bytebureau/worktrees/s1'

const NOTHING: PermissionRecommendation = { recommended: null, ruleId: null }
const ALLOWED: PermissionRecommendation = { recommended: 'allow', ruleId: 'read-only-command' }
const SECRET: PermissionRecommendation = { recommended: 'deny', ruleId: 'secrets-path' }
const REMOVAL: PermissionRecommendation = { recommended: 'deny', ruleId: 'rm-outside-workspace' }

const shell = (command: string, workspace = ws): PermissionRecommendation =>
  recommendForPermission({ name: 'Bash', input: { command } }, workspace, 'supervised')

describe('recommendForPermission commands that name secrets', () => {
  it.each([
    ['cat .env'],
    ['cat ~/.ssh/id_rsa'],
    ['head -c 200 ~/.aws/credentials'],
    ['cat "src/../.env.local"'],
    ['tail -n 5 ../other/.npmrc'],
    ['cp .env /tmp/stolen'],
  ])('denies %s', (command) => {
    expect(shell(command)).toStrictEqual(SECRET)
  })

  it.each([['/home/me/.ENV'], [`${ws}/key.PEM`], [`${ws}/.SSH/config`]])(
    'denies the secret %s whatever its case',
    (filePath) => {
      const read = recommendForPermission(
        { name: 'Read', input: { file_path: filePath } },
        ws,
        'supervised',
      )
      expect(read).toStrictEqual(SECRET)
    },
  )
})

describe('recommendForPermission read-only commands that reach outside the workspace', () => {
  it.each([
    ['cat /etc/passwd'],
    ['grep -r password /home/me'],
    ['ls ..'],
    ['cat $HOME/notes.txt'],
    ['wc -l ~/notes.txt'],
    ['rg --glob=../** secret'],
  ])('recommends nothing for %s', (command) => {
    expect(shell(command)).toStrictEqual(NOTHING)
  })

  it.each([['ls .'], ['grep -r TODO .'], [`cat ${ws}/src/a.ts`], ['rg --glob=*.ts hello src']])(
    'still allows %s, which stays inside',
    (command) => {
      expect(shell(command)).toStrictEqual(ALLOWED)
    },
  )
})

describe('recommendForPermission read-only commands with a flag that writes or runs', () => {
  it.each([
    ['git branch -D main'],
    ['git branch -d topic'],
    ['git branch -m old new'],
    ['git branch -M new'],
    ['git branch -rd origin/x'],
    ['git branch --delete topic'],
    ['git branch --set-upstream-to=origin/main'],
    ['git branch topic'],
    ['rg --pre cat secret'],
    ['rg --pre=sh secret'],
    ['rg --pre-glob *.gz secret'],
    ['grep --pre x y'],
    ['git diff --output=/tmp/patch'],
    ['git diff --output patch.txt'],
    ['git log --output=log.txt'],
  ])('recommends nothing for %s', (command) => {
    expect(shell(command)).toStrictEqual(NOTHING)
  })

  it.each([['git branch'], ['git branch -a'], ['git branch -vv'], ['git branch --list bb/*']])(
    'allows %s, which only lists',
    (command) => {
      expect(shell(command)).toStrictEqual(ALLOWED)
    },
  )
})

describe('recommendForPermission recursive removals', () => {
  it.each([['rm -rf node_modules'], ['rm -rf ./build dist'], [`rm -rf ${ws}/build`]])(
    'does not blame %s, which stays inside the workspace, on the removal rule',
    (command) => {
      expect(shell(command)).toStrictEqual(NOTHING)
    },
  )

  it.each([['rm -rf .'], ['rm -rf ..'], ['rm -rf ../s2'], ['rm -rf $HOME/x'], ['rm -rf ~/x']])(
    'denies %s, which reaches the workspace itself or beyond',
    (command) => {
      expect(shell(command)).toStrictEqual(REMOVAL)
    },
  )

  it('denies every recursive removal of a workspace that is no absolute path', () => {
    expect(shell('rm -rf relative/ws/build', 'relative/ws')).toStrictEqual(REMOVAL)
  })
})

const glob = (input: Record<string, string>): PermissionRecommendation =>
  recommendForPermission({ name: 'Glob', input }, ws, 'supervised')

describe('recommendForPermission globs', () => {
  it.each([
    [{ pattern: '../../**/*.ts' }],
    [{ pattern: '**/*.ts', path: '/etc' }],
    [{ pattern: '*.ts', path: '../..' }],
    [{ pattern: '/etc/**' }],
  ])('recommends nothing for a glob that leaves the workspace: %o', (input) => {
    expect(glob(input)).toStrictEqual(NOTHING)
  })

  it.each([[{ pattern: '**/*.ts' }], [{ pattern: '*.md', path: 'docs' }]])(
    'allows a glob inside the workspace: %o',
    (input) => {
      expect(glob(input)).toStrictEqual({ recommended: 'allow', ruleId: 'in-workspace-edit' })
    },
  )
})
