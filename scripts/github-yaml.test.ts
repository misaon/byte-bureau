import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const root = new URL('..', import.meta.url).pathname

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

  it('disables blank issues', () => {
    const config: unknown = parse(
      readFileSync(path.join(root, '.github/ISSUE_TEMPLATE/config.yml'), 'utf8'),
    )
    expect(config).toHaveProperty('blank_issues_enabled', false)
  })
})
