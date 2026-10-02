import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SOURCE = path.join(import.meta.dirname, '../../../docs/decisions')
const TARGET = path.join(import.meta.dirname, '../src/content/docs/decisions')

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
  return `---\ntitle: ${quote(title)}\nsidebar:\n  label: ${quote(label)}\n---\n\n${bodyText}`
}

export async function syncDecisions(): Promise<string[]> {
  await rm(TARGET, { recursive: true, force: true })
  await mkdir(TARGET, { recursive: true })
  const entries = await readdir(SOURCE)
  const files = entries.filter((name) => name.endsWith('.md')).toSorted()
  await Promise.all(
    files.map(async (name) => {
      const markdown = await readFile(path.join(SOURCE, name), 'utf8')
      await writeFile(path.join(TARGET, name), withFrontmatter(markdown, name))
    }),
  )
  return files
}

if (import.meta.main) {
  const files = await syncDecisions()
  console.log(`synced ${files.length} decision records`)
}
