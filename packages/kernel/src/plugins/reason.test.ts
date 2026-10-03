import { describe, expect, it } from 'vitest'
import { reasonOf } from './reason.js'

describe(reasonOf, () => {
  it('reports the message of an error and the text of anything else', () => {
    expect(reasonOf(new Error('boom'))).toBe('boom')
    expect(reasonOf('plain text')).toBe('plain text')
    expect(reasonOf(42)).toBe('42')
  })
})
