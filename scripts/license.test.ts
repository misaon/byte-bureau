import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('..', import.meta.url).pathname
const read = (path: string): string => readFileSync(`${root}/${path}`, 'utf8')

describe('licence layer', () => {
  it('ships the FSL-1.1-MIT text with the licensor filled in', () => {
    const licence = read('LICENSE.md')
    expect(licence).toContain('Functional Source License, Version 1.1, MIT Future License')
    expect(licence).toContain('Ondřej Misák')
    expect(licence).not.toMatch(/\{[A-Za-z ]+\}/u)
  })

  it('declares FSL-1.1-MIT in every private package manifest', () => {
    expect.hasAssertions()
    for (const manifest of [
      'package.json',
      'apps/bytebureau/package.json',
      'packages/i18n/package.json',
      'packages/tsconfig/package.json',
    ]) {
      expect(JSON.parse(read(manifest)), manifest).toHaveProperty('license', 'FSL-1.1-MIT')
    }
  })

  it('ships a trademark policy that names the marks', () => {
    expect(read('TRADEMARK.md')).toContain('ByteBureau')
  })
})
