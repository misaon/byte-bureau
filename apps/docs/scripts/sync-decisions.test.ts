import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { syncDecisions, withFrontmatter } from './sync-decisions.js'

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bytebureau-decisions-'))
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function seed(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      await writeFile(path.join(dir, name), content)
    }),
  )
}

describe(withFrontmatter, () => {
  it('moves the first heading into Starlight frontmatter and keeps the body', () => {
    const input = '# Bun as runtime\n\n- Status: accepted\n\n## Context\n\nText.\n'
    expect(withFrontmatter(input, '0002-bun-runtime.md')).toBe(
      '---\ntitle: "Bun as runtime"\nsidebar:\n  label: "0002 Bun as runtime"\neditUrl: https://github.com/misaon/byte-bureau/edit/main/docs/decisions/0002-bun-runtime.md\n---\n\n- Status: accepted\n\n## Context\n\nText.\n',
    )
  })

  it('falls back to the file name when there is no heading', () => {
    expect(withFrontmatter('Just text\n', '0042-no-heading.md')).toBe(
      '---\ntitle: "0042 no heading"\nsidebar:\n  label: "0042 no heading"\neditUrl: https://github.com/misaon/byte-bureau/edit/main/docs/decisions/0042-no-heading.md\n---\n\nJust text\n',
    )
  })

  it('escapes double quotes in titles', () => {
    expect(withFrontmatter('# Say "hi"\n', '0001-x.md')).toContain(String.raw`title: "Say \"hi\""`)
  })

  it('escapes backslashes in titles', () => {
    expect(withFrontmatter('# Back\\slash\n', '0001-x.md')).toContain(
      String.raw`title: "Back\\slash"`,
    )
  })
})

describe(syncDecisions, () => {
  it('clears the target and writes one page per Markdown record, ignoring other files', async () => {
    expect.hasAssertions()
    const source = await tempDir()
    const target = await tempDir()
    await seed(target, { '0099-stale.md': '# Stale\n' })
    await seed(source, {
      '0002-b.md': '# Bee\n',
      '0001-a.md': '# Ay\n',
      'notes.txt': 'not a record',
    })
    await expect(syncDecisions(source, target)).resolves.toStrictEqual(['0001-a.md', '0002-b.md'])
    const written = await readdir(target)
    expect(written.toSorted()).toStrictEqual(['0001-a.md', '0002-b.md'])
    await expect(readFile(path.join(target, '0002-b.md'), 'utf8')).resolves.toContain(
      'title: "Bee"',
    )
  })
})
