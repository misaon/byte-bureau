import { describe, expect, it } from 'vitest'
import { branchSlug } from './slug.js'

const SESSION_ID = '0192f0c8-7b2e-7c3d-9a4b-000000000001'

describe(branchSlug, () => {
  it('kebab-cases the title, strips diacritics and caps the length', () => {
    expect(branchSlug('Create src/hello.ts exporting hello()', 's')).toBe(
      'bb/create-src-hello-ts-exporting-hello',
    )
    expect(branchSlug('Přidat českou podporu!', 's')).toBe('bb/pridat-ceskou-podporu')
    expect(branchSlug('a'.repeat(80), 's')).toBe(`bb/${'a'.repeat(40)}`)
  })

  it('falls back to the short session id when nothing is left', () => {
    expect(branchSlug('???', SESSION_ID)).toBe('bb/s-0192f0c8')
  })

  it('falls back for an empty title, for symbols and for marks without a letter', () => {
    expect(branchSlug('', SESSION_ID)).toBe('bb/s-0192f0c8')
    expect(branchSlug('🎉 ✨', SESSION_ID)).toBe('bb/s-0192f0c8')
    expect(branchSlug('́́', SESSION_ID)).toBe('bb/s-0192f0c8')
  })

  it('does not end on the dash that the cut leaves behind', () => {
    expect(branchSlug(`${'a'.repeat(39)} b`, 's')).toBe(`bb/${'a'.repeat(39)}`)
  })

  it('keeps digits and collapses every run of other characters into one dash', () => {
    expect(branchSlug('  Fix #42 --  the   build_  ', 's')).toBe('bb/fix-42-the-build')
  })
})
