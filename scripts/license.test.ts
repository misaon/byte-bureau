import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8')

// SDK packages published under MIT (ADR-0005); every other manifest is FSL-1.1-MIT
const MIT_MANIFESTS = new Set([
  'packages/protocol/package.json',
  'packages/plugin-api/package.json',
])
const expectedLicense = (manifest: string): string =>
  MIT_MANIFESTS.has(manifest) ? 'MIT' : 'FSL-1.1-MIT'

// The root manifest plus apps/*/package.json, packages/*/package.json and plugins/*/package.json
const manifests = [
  'package.json',
  ...['apps', 'packages', 'plugins'].flatMap((parent) => {
    const parentPath = path.join(root, parent)
    if (!existsSync(parentPath)) {
      return []
    }
    return readdirSync(parentPath)
      .map((name) => path.join(parent, name, 'package.json'))
      .filter((manifest) => existsSync(path.join(root, manifest)))
  }),
]

describe('licence layer', () => {
  it('ships the FSL-1.1-MIT text with the licensor filled in', () => {
    const licence = read('LICENSE.md')
    expect(licence).toContain('Functional Source License, Version 1.1, MIT Future License')
    expect(licence).toContain('Ondřej Misák')
    expect(licence).not.toMatch(/\{[A-Za-z ]+\}/u)
  })

  it('declares FSL-1.1-MIT in the root, app and package manifests and MIT in the SDK packages', () => {
    expect.hasAssertions()
    expect(manifests).toContain('apps/docs/package.json')
    for (const manifest of manifests) {
      expect(JSON.parse(read(manifest)), manifest).toHaveProperty(
        'license',
        expectedLicense(manifest),
      )
    }
  })

  it('ships a trademark policy that names the marks', () => {
    expect(read('TRADEMARK.md')).toContain('ByteBureau')
  })
})
