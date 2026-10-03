import { describe, expect, it } from 'vitest'
import { parseStatusV2 } from './status-parser.js'

const clean = `# branch.oid 1234567
# branch.head bb/add-hello
# branch.upstream origin/main
# branch.ab +2 -1
`
const dirty = `${clean}1 .M N... 100644 100644 100644 abc def src/hello.ts
? notes.txt
`

const renamed = `${clean}2 R. N... 100644 100644 100644 abc def R100 new.ts\told.ts
`
const unmerged = `${clean}u UU N... 100644 100644 100644 100644 abc def ghi conflict.ts
`
const ignored = `${clean}! build/output.log
`

describe(parseStatusV2, () => {
  it('reads branch name and ahead/behind from the headers', () => {
    expect(parseStatusV2(clean)).toStrictEqual({
      dirty: false,
      ahead: 2,
      behind: 1,
      branch: 'bb/add-hello',
    })
  })

  it('reports dirty when any change or untracked entry is present', () => {
    expect(parseStatusV2(dirty).dirty).toBe(true)
  })

  it.each([
    ['a renamed file', renamed],
    ['an unmerged file', unmerged],
  ])('reports %s as dirty', (_name, text) => {
    expect(parseStatusV2(text).dirty).toBe(true)
  })

  it('counts an ignored entry as clean', () => {
    expect(parseStatusV2(ignored).dirty).toBe(false)
  })

  it('tolerates a detached head and a missing upstream', () => {
    expect(parseStatusV2('# branch.oid abc\n# branch.head (detached)\n')).toStrictEqual({
      dirty: false,
      ahead: 0,
      behind: 0,
      branch: '(detached)',
    })
  })
})
