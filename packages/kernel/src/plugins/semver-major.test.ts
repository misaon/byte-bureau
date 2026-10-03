import { describe, expect, it } from 'vitest'
import { satisfiesMajor } from './semver-major.js'

describe(satisfiesMajor, () => {
  it('accepts caret ranges of the same major and rejects others', () => {
    expect(satisfiesMajor('^0', '0.0.0')).toBe(true)
    expect(satisfiesMajor('^0.1.0', '0.4.2')).toBe(true)
    expect(satisfiesMajor('^1', '0.9.0')).toBe(false)
    expect(satisfiesMajor('>=1', '1.0.0')).toBe(false)
  })

  it.each(['0', '~0.1', '^0.x', '^0.1.2.3', '', '^'])('refuses the range "%s"', (range) => {
    expect(satisfiesMajor(range, '0.0.0')).toBe(false)
  })

  it('refuses a version that is not dotted', () => {
    expect(satisfiesMajor('^0', '0')).toBe(false)
  })
})
