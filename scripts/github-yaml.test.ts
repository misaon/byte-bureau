import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const USES = /^\s*-?\s*uses:\s*(?<ref>\S+)(?<rest>.*)$/u
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/u
const TAG_COMMENT = /^\s+#\s*\S+/u

interface UsesLine {
  readonly where: string
  readonly ref: string
  readonly rest: string
}

function usesLines(file: string): UsesLine[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      const { groups } = USES.exec(line) ?? {}
      return groups === undefined
        ? []
        : [
            {
              where: `${file.replace(root, '')}:${index + 1}`,
              ref: groups['ref'] ?? '',
              rest: groups['rest'] ?? '',
            },
          ]
    })
}

function yamlFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const entry = path.join(dir, name)
    if (statSync(entry).isDirectory()) {
      return yamlFiles(entry)
    }
    return name.endsWith('.yml') || name.endsWith('.yaml') ? [entry] : []
  })
}

describe('.github YAML', () => {
  const files = yamlFiles(path.join(root, '.github'))

  it('contains the issue forms, labeler and funding files', () => {
    expect.hasAssertions()
    const names = files.map((file) => file.replace(root, ''))
    for (const expected of [
      '.github/ISSUE_TEMPLATE/bug.yml',
      '.github/ISSUE_TEMPLATE/feature.yml',
      '.github/ISSUE_TEMPLATE/plugin.yml',
      '.github/ISSUE_TEMPLATE/config.yml',
      '.github/labeler.yml',
      '.github/FUNDING.yml',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('parses every YAML file', () => {
    expect.hasAssertions()
    for (const file of files) {
      expect(() => {
        parse(readFileSync(file, 'utf8'))
      }, file).not.toThrow()
    }
  })

  it('pins every non-local action to a commit SHA with its tag in a comment', () => {
    expect.hasAssertions()
    const uses = files.flatMap((file) => usesLines(file))
    const external = uses.filter(({ ref }) => !ref.startsWith('./'))
    expect(external.length).toBeGreaterThan(0)
    expect(uses.length).toBeGreaterThan(external.length)
    for (const { where, ref, rest } of external) {
      expect(ref, where).toMatch(PINNED)
      expect(rest, where).toMatch(TAG_COMMENT)
    }
  })

  it('disables blank issues', () => {
    const config: unknown = parse(
      readFileSync(path.join(root, '.github/ISSUE_TEMPLATE/config.yml'), 'utf8'),
    )
    expect(config).toHaveProperty('blank_issues_enabled', false)
  })
})
