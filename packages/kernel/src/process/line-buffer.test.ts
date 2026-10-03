import { describe, expect, it } from 'vitest'
import { LineBuffer } from './line-buffer.js'

describe(LineBuffer, () => {
  it('keeps the newest lines up to the limit and counts drops', () => {
    const buffer = new LineBuffer(3)
    for (const line of ['a', 'b', 'c', 'd', 'e']) {
      buffer.push(line)
    }
    expect(buffer.lines()).toStrictEqual(['c', 'd', 'e'])
    expect(buffer.dropped).toBe(2)
  })

  it('drops nothing below the limit and hands out copies', () => {
    const buffer = new LineBuffer(3)
    buffer.push('a')
    const first = buffer.lines()
    buffer.push('b')
    expect(first).toStrictEqual(['a'])
    expect(buffer.lines()).toStrictEqual(['a', 'b'])
    expect(buffer.dropped).toBe(0)
  })
})
