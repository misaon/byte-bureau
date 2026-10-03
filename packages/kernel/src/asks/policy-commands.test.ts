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
  ])('recommends nothing for %s, which reaches outside', (command) => {
    expect(shell(command)).toStrictEqual(NOTHING)
  })

  it.each([['ls .'], ['grep -r TODO .'], [`cat ${ws}/src/a.ts`], [`rg --glob='*.ts' hello src`]])(
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
  ])('recommends nothing for %s, whose flag writes or runs', (command) => {
    expect(shell(command)).toStrictEqual(NOTHING)
  })

  it.each([['git branch'], ['git branch -a'], ['git branch -vv'], [`git branch --list 'bb/*'`]])(
    'allows %s, which only lists',
    (command) => {
      expect(shell(command)).toStrictEqual(ALLOWED)
    },
  )
})

describe('recommendForPermission words the shell expands', () => {
  it.each([
    ['cat .env*'],
    ['cat .e?v'],
    ['cat .en[v]'],
    ['cat {.env,}'],
    ['head -n1 .e*'],
    [String.raw`cat \/etc/passwd`],
    ['cat {/etc/passwd,}'],
    ['wc -c {/etc/passwd,}'],
    ['rg -uuu password {/Users,}'],
    [String.raw`git diff --no-index \/etc/passwd x`],
    ['rg --glob=*.ts hello src'],
    ['git branch --list bb/*'],
    ['cat "$HOME/notes.txt"'],
    ['cat "unterminated'],
  ])('recommends nothing for %s, which the shell expands', (command) => {
    expect(shell(command)).toStrictEqual(NOTHING)
  })

  it.each([[`cat 'src/a*.ts'`], ['cat "src/a?.ts"'], [`grep -r 'a{1,2}' src`]])(
    'allows %s, whose quotes keep the shell from expanding it',
    (command) => {
      expect(shell(command)).toStrictEqual(ALLOWED)
    },
  )

  it('denies the secret behind an escape, which the shell drops', () => {
    expect(shell(String.raw`cat \.env`)).toStrictEqual(SECRET)
  })
})

describe('recommendForPermission values attached to a short flag', () => {
  it.each([
    ['grep -f/etc/passwd x'],
    ['grep -rf../../etc/passwd x'],
    ['git log -L1,5:/etc/passwd'],
  ])('recommends nothing for %s, whose flag value leaves the workspace', (command) => {
    expect(shell(command)).toStrictEqual(NOTHING)
  })

  it('denies the secret a flag reads', () => {
    expect(shell('grep -f.env x')).toStrictEqual(SECRET)
  })

  it.each([['head -n5 src/a.ts'], ['grep -C2 foo src'], ['ls -la src'], ['ls -1']])(
    'still allows %s',
    (command) => {
      expect(shell(command)).toStrictEqual(ALLOWED)
    },
  )
})

describe('recommendForPermission paths of a git revision and after --', () => {
  it.each([['git show HEAD:.env'], ['git show :0:.env']])('denies the secret of %s', (command) => {
    expect(shell(command)).toStrictEqual(SECRET)
  })

  it.each([
    ['git show HEAD:../../etc/passwd'],
    ['cat -- -/../../../../etc/passwd'],
    ['git log -- -/../../../..'],
  ])('recommends nothing for %s, whose path leaves the workspace', (command) => {
    expect(shell(command)).toStrictEqual(NOTHING)
  })

  it.each([['git show HEAD:src/a.ts'], ['git log -- src'], ['git log --format=%h:%s']])(
    'allows %s, which stays inside',
    (command) => {
      expect(shell(command)).toStrictEqual(ALLOWED)
    },
  )
})

const spaced = '/Users/me/My Projects/app/.bytebureau/worktrees/s1'

describe('recommendForPermission quoted words with spaces', () => {
  it.each([[`rm -rf "${spaced}/node_modules"`], [`rm -rf '${spaced}/build'`]])(
    'does not blame %s, which stays inside a workspace with a space in its path, on the removal rule',
    (command) => {
      expect(shell(command, spaced)).toStrictEqual(NOTHING)
    },
  )

  it('allows reading a quoted file of such a workspace', () => {
    expect(shell(`cat "${spaced}/src/a b.ts"`, spaced)).toStrictEqual(ALLOWED)
  })

  it('denies a quoted removal outside it', () => {
    expect(shell('rm -rf "/Users/me/My Projects/other"', spaced)).toStrictEqual(REMOVAL)
  })
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
