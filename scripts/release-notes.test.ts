import { describe, expect, it } from 'vitest'
import { extractReleaseNotes } from './release-notes.js'

const changelog = `# Changelog

## v0.2.0

[compare changes](https://github.com/misaon/byte-bureau/compare/v0.1.0...v0.2.0)

### 🚀 Enhancements

- **cli:** add doctor command

## v0.1.0

### 🏡 Chore

- **repo:** bootstrap
`

describe(extractReleaseNotes, () => {
  it('returns the body of the requested version only', () => {
    expect(extractReleaseNotes(changelog, '0.2.0')).toBe(
      '[compare changes](https://github.com/misaon/byte-bureau/compare/v0.1.0...v0.2.0)\n\n### 🚀 Enhancements\n\n- **cli:** add doctor command',
    )
  })

  it('returns the last section when it has no successor', () => {
    expect(extractReleaseNotes(changelog, '0.1.0')).toBe('### 🏡 Chore\n\n- **repo:** bootstrap')
  })

  it('throws when the version is missing', () => {
    expect(() => extractReleaseNotes(changelog, '9.9.9')).toThrow('no section for version 9.9.9')
  })

  it('throws when the section is empty', () => {
    expect(() =>
      extractReleaseNotes('# Changelog\n\n## v0.3.0\n\n## v0.2.0\n\ntext\n', '0.3.0'),
    ).toThrow('empty')
  })
})
