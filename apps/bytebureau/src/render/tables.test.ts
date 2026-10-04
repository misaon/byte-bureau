import { describe, expect, it } from 'vitest'
import { table } from './tables.js'

describe(table, () => {
  it('pads every column to its widest cell with two spaces between columns', () => {
    expect(
      table([
        ['a', 'bb', 'c'],
        ['dddd', 'e', 'f'],
      ]),
    ).toStrictEqual(['a     bb  c', 'dddd  e   f'])
  })

  it('leaves the last column unpadded and renders no rows as no lines', () => {
    expect(table([['x', 'y']])).toStrictEqual(['x  y'])
    expect(table([])).toStrictEqual([])
  })

  it('ends a line at its last cell, even when that cell is empty', () => {
    expect(
      table([
        ['id', 'note'],
        ['longer', ''],
      ]),
    ).toStrictEqual(['id      note', 'longer'])
  })

  it('tells a cell that spans lines on one line, so a row stays a line', () => {
    expect(
      table([
        ['a1', 'Run:\n  ls -l\r\n  pwd'],
        ['a22', 'Write'],
      ]),
    ).toStrictEqual(['a1   Run: ls -l pwd', 'a22  Write'])
  })

  it('keeps the width of a column that a shorter row leaves out', () => {
    expect(table([['one', 'two', 'three'], ['x'], ['four', 'y']])).toStrictEqual([
      'one   two  three',
      'x',
      'four  y',
    ])
  })
})
