import { describe, expect, it } from 'vitest'
import { mergeConfig } from './merge.js'

describe(mergeConfig, () => {
  it('merges objects deeply and replaces arrays instead of concatenating them', () => {
    const merged = mergeConfig(
      { workspace: { copyIgnored: ['.env'], retainDays: 7 }, logging: { level: 'info' } },
      { workspace: { copyIgnored: ['.env.local'] }, logging: { level: 'debug' } },
    )
    expect(merged).toStrictEqual({
      workspace: { copyIgnored: ['.env.local'], retainDays: 7 },
      logging: { level: 'debug' },
    })
  })

  it('ignores undefined overlay values', () => {
    expect(mergeConfig({ kept: 1 }, { kept: undefined, added: 2 })).toStrictEqual({
      kept: 1,
      added: 2,
    })
  })

  it('ignores undefined values inside a section the base does not have', () => {
    expect(mergeConfig({}, { section: { kept: 1, dropped: undefined } })).toStrictEqual({
      section: { kept: 1 },
    })
  })

  it('leaves both inputs untouched and shares no section with the overlay', () => {
    const base = { section: { fromBase: 1 } }
    const overlay = { section: { fromOverlay: 2 }, added: { nested: true } }
    const merged = mergeConfig(base, overlay)
    expect(base).toStrictEqual({ section: { fromBase: 1 } })
    expect(overlay).toStrictEqual({ section: { fromOverlay: 2 }, added: { nested: true } })
    expect(merged['added']).toStrictEqual({ nested: true })
    expect(merged['added']).not.toBe(overlay.added)
  })
})
