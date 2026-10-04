import { describe, expect, it } from 'vitest'
import { quietOnClosedPipe } from './closed-pipe.js'

const failure = (code: string): Error => Object.assign(new Error(`${code}: write`), { code })

describe(quietOnClosedPipe, () => {
  it('lets a write to a pipe whose reader went away go without a word', () => {
    expect(() => {
      quietOnClosedPipe(failure('EPIPE'))
    }).not.toThrow()
  })

  it('passes any other failure of the stream on', () => {
    const other = failure('EIO')
    expect(() => {
      quietOnClosedPipe(other)
    }).toThrow(other)
  })
})
