import { describe, expect, it } from 'vitest'
import { baseLocale, isLocale, locales, m, setLocale } from './index.js'

describe('@bytebureau/i18n', () => {
  it('exposes en and cs with en as base', () => {
    expect([...locales].toSorted()).toStrictEqual(['cs', 'en'])
    expect(baseLocale).toBe('en')
    expect(isLocale('cs')).toBe(true)
    expect(isLocale('de')).toBe(false)
  })

  it('renders messages in the active locale', () => {
    setLocale('en')
    expect(m.hello_greeting({ name: 'Ondřej' })).toBe('Hello, Ondřej! ByteBureau is ready.')
    setLocale('cs')
    expect(m.hello_greeting({ name: 'Ondřej' })).toBe('Ahoj, Ondřej! ByteBureau je připraveno.')
    expect(m.hello_anonymous()).toBe('Ahoj! ByteBureau je připraveno.')
  })
})
