import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8')
const headings = (markdown: string): number =>
  markdown.split('\n').filter((line) => line.startsWith('## ')).length

// The decisions/ folders are generated from docs/decisions, which is checked directly
function handWrittenPages(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'decisions' ? [] : handWrittenPages(file)
    }
    return /\.mdx?$/u.test(entry.name) ? [file] : []
  })
}

const publishedTexts = [
  'README.md',
  'README.cs.md',
  ...readdirSync(path.join(root, 'docs/decisions'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join('docs/decisions', name)),
  ...handWrittenPages('apps/docs/src/content/docs'),
]

describe('published texts', () => {
  it('never call the project open source', () => {
    expect.hasAssertions()
    for (const file of publishedTexts) {
      expect(read(file), file).not.toMatch(/open[\s-]source/iu)
    }
  })

  it('cover both READMEs, every ADR and the hand-written docs pages only', () => {
    expect(publishedTexts).toStrictEqual(
      expect.arrayContaining([
        'README.cs.md',
        'docs/decisions/0006-agent-authentication-policy.md',
        'apps/docs/src/content/docs/install.md',
        'apps/docs/src/content/docs/cs/index.mdx',
      ]),
    )
    expect(
      publishedTexts.filter((file) => file.startsWith('apps/docs/src/content/docs/decisions/')),
    ).toStrictEqual([])
  })
})

describe('the README', () => {
  it('stays under 300 lines', () => {
    expect(read('README.md').split('\n').length).toBeLessThanOrEqual(300)
  })

  it('has a Czech mirror with the same section structure', () => {
    expect(headings(read('README.cs.md'))).toBe(headings(read('README.md')))
  })

  it('seeds the changelog with the heading changelogen expects', () => {
    expect(read('CHANGELOG.md')).toMatch(/^# Changelog/u)
  })
})
