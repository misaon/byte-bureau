import { describe, expect, it } from 'vitest'
import cs from '../messages/cs.json' with { type: 'json' }
import en from '../messages/en.json' with { type: 'json' }

type Catalogue = Record<string, unknown>
const PARAM = /\{(?<name>\w+)\}/gu

function keysOf(catalogue: Catalogue): string[] {
  return Object.keys(catalogue)
    .filter((key) => !key.startsWith('$'))
    .toSorted()
}

function paramsOf(text: unknown): string[] {
  return [...String(text).matchAll(PARAM)]
    .map((match) => (match.groups === undefined ? '' : (match.groups['name'] ?? '')))
    .toSorted()
}

describe('message catalogues', () => {
  it('contain the same keys in cs and en', () => {
    expect(keysOf(cs)).toStrictEqual(keysOf(en))
  })

  it('use the same parameters for every key', () => {
    expect.hasAssertions()
    for (const key of keysOf(en)) {
      expect(paramsOf((cs as Catalogue)[key]), key).toStrictEqual(paramsOf((en as Catalogue)[key]))
    }
  })

  it('has no empty translations', () => {
    expect.hasAssertions()
    for (const catalogue of [en, cs]) {
      for (const key of keysOf(catalogue)) {
        expect(String((catalogue as Catalogue)[key]).trim(), key).not.toBe('')
      }
    }
  })
})
