import { describe, expect, it } from 'vitest'
import { drained } from './drain.js'

describe(drained, () => {
  it('waits until the stream has taken in what was written to it before', async () => {
    expect.hasAssertions()
    const order: string[] = []
    const stream = {
      write: (chunk: string, taken: () => void): boolean => {
        setTimeout(() => {
          order.push(`taken ${JSON.stringify(chunk)}`)
          taken()
        }, 20)
        return false
      },
    }
    await drained(stream)
    order.push('drained')
    expect(order).toStrictEqual(['taken ""', 'drained'])
  })

  it('waits no longer than the limit for a stream that never takes anything in', async () => {
    expect.hasAssertions()
    const stream = { write: (): boolean => false }
    const started = performance.now()
    await drained(stream, 50)
    expect(performance.now() - started).toBeGreaterThanOrEqual(45)
  })
})
