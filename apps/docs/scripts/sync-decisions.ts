import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SOURCE = path.join(import.meta.dirname, '../../../docs/decisions')
const TARGET = path.join(import.meta.dirname, '../src/content/docs/decisions')
// Synced copies are not tracked, so the site-wide edit link would point at a missing file
const EDIT_URL_BASE = 'https://github.com/misaon/byte-bureau/edit/main/docs/decisions/'

function quote(value: string): string {
  return `"${value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

function labelFor(fileName: string, title: string): string {
  const number = fileName.slice(0, 4)
  return `${number} ${title}`
}

export function withFrontmatter(markdown: string, fileName: string): string {
  const lines = markdown.split('\n')
  const headingIndex = lines.findIndex((line) => line.startsWith('# '))
  const fallback = fileName
    .replace(/\.md$/u, '')
    .replace(/^\d{4}-/u, '')
    .replaceAll('-', ' ')
  const headingTitle = headingIndex === -1 ? undefined : (lines[headingIndex] ?? '').slice(2).trim()
  const title = headingTitle ?? labelFor(fileName, fallback)
  const label = headingTitle === undefined ? title : labelFor(fileName, headingTitle)
  const body = headingIndex === -1 ? lines : lines.filter((_line, index) => index !== headingIndex)
  const bodyText = body.join('\n').replace(/^\n+/u, '')
  // The editUrl stays unquoted: .ls-lint.yml limits .md names to kebab-case or SCREAMING_SNAKE_CASE
  return `---\ntitle: ${quote(title)}\nsidebar:\n  label: ${quote(label)}\neditUrl: ${EDIT_URL_BASE}${fileName}\n---\n\n${bodyText}`
}

export async function syncDecisions(source = SOURCE, target = TARGET): Promise<string[]> {
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  const entries = await readdir(source)
  const files = entries.filter((name) => name.endsWith('.md')).toSorted()
  await Promise.all(
    files.map(async (name) => {
      const markdown = await readFile(path.join(source, name), 'utf8')
      await writeFile(path.join(target, name), withFrontmatter(markdown, name))
    }),
  )
  return files
}

/* v8 ignore start */
if (import.meta.main) {
  const files = await syncDecisions()
  console.log(`synced ${files.length} decision records`)
}
/* v8 ignore stop */
