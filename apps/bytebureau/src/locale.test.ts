import { describe, expect, it } from 'vitest'
import { resolveLocale } from './locale.js'

describe(resolveLocale, () => {
  it('prefers the --lang flag', () => {
    expect(resolveLocale({ flag: 'cs', env: { LANG: 'en_US.UTF-8' } })).toStrictEqual({
      locale: 'cs',
    })
  })

  it('falls back to English with a warning for an unsupported explicit value', () => {
    expect(resolveLocale({ flag: 'de', env: {} })).toStrictEqual({
      locale: 'en',
      unsupported: 'de',
    })
    expect(resolveLocale({ env: { BYTEBUREAU_LANG: 'fr' } })).toStrictEqual({
      locale: 'en',
      unsupported: 'fr',
    })
  })

  it('reads BYTEBUREAU_LANG before LC_ALL and LANG', () => {
    expect(
      resolveLocale({ env: { BYTEBUREAU_LANG: 'cs', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' } }),
    ).toStrictEqual({ locale: 'cs' })
    expect(resolveLocale({ env: { LC_ALL: 'cs_CZ.UTF-8', LANG: 'en_US.UTF-8' } })).toStrictEqual({
      locale: 'cs',
    })
  })

  it('normalises POSIX locale strings', () => {
    expect(resolveLocale({ env: { LANG: 'cs_CZ.UTF-8' } })).toStrictEqual({ locale: 'cs' })
    expect(resolveLocale({ env: { LANG: 'CS_CZ' } })).toStrictEqual({ locale: 'cs' })
    expect(resolveLocale({ env: { LANG: 'cs@latin' } })).toStrictEqual({ locale: 'cs' })
  })

  it('silently uses English for C, POSIX, empty and unknown implicit locales', () => {
    expect.hasAssertions()
    for (const value of ['C.UTF-8', 'POSIX', '', 'de_DE.UTF-8', '   ']) {
      expect(resolveLocale({ env: { LANG: value } }), value).toStrictEqual({ locale: 'en' })
    }
    expect(resolveLocale({ env: {} })).toStrictEqual({ locale: 'en' })
  })
})
