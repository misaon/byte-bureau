import { describe, expect, it } from 'vitest'
import { withFrontmatter } from './sync-decisions.js'

describe(withFrontmatter, () => {
  it('moves the first heading into Starlight frontmatter and keeps the body', () => {
    const input = '# Bun as runtime\n\n- Status: accepted\n\n## Context\n\nText.\n'
    expect(withFrontmatter(input, '0002-bun-runtime.md')).toBe(
      '---\ntitle: "Bun as runtime"\nsidebar:\n  label: "0002 Bun as runtime"\n---\n\n- Status: accepted\n\n## Context\n\nText.\n',
    )
  })

  it('falls back to the file name when there is no heading', () => {
    expect(withFrontmatter('Just text\n', '0042-no-heading.md')).toBe(
      '---\ntitle: "0042 no heading"\nsidebar:\n  label: "0042 no heading"\n---\n\nJust text\n',
    )
  })

  it('escapes double quotes in titles', () => {
    expect(withFrontmatter('# Say "hi"\n', '0001-x.md')).toContain(String.raw`title: "Say \"hi\""`)
  })
})
