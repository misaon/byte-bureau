import { describe, expect, it } from 'vitest'
import { isPlain, mergeConfig, type Plain } from './merge.js'

// A document parsed by JSON.parse, which defines every key, __proto__ too, as an own key
function parsed(text: string): Plain {
  const value: unknown = JSON.parse(text)
  if (!isPlain(value)) {
    throw new TypeError('not an object')
  }
  return value
}

function sectionOf(merged: Plain): Plain {
  const { section } = merged
  if (!isPlain(section)) {
    throw new TypeError('no section')
  }
  return section
}

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

  it('keeps a __proto__ key a key, never the prototype of the result', () => {
    const merged = mergeConfig({}, parsed('{ "section": { "__proto__": { "polluted": true } } }'))
    const section = sectionOf(merged)
    expect(Reflect.getPrototypeOf(section)).toBe(Object.prototype)
    expect(Object.keys(section)).toStrictEqual(['__proto__'])
    expect(Reflect.get(section, 'polluted')).toBeUndefined()
  })
})
