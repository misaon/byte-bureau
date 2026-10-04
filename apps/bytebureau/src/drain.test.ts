import { describe, expect, it } from 'vitest'
import { drained } from './drain.js'

// A pipe as Bun writes to it: a write is taken in a while later, an empty one is called back at once
const pipe = (
  order: string[],
): Parameters<typeof drained>[0] & { readonly pending: Set<string> } => {
  const pending = new Set<string>()
  const ended: (() => void)[] = []
  const take = (chunk: string, taken: () => void): void => {
    pending.delete(chunk)
    order.push(`taken ${chunk}`)
    taken()
    if (pending.size === 0) {
      for (const done of ended.splice(0)) {
        done()
      }
    }
  }
  return {
    pending,
    write: (chunk, taken) => {
      if (chunk === '') {
        taken()
        return true
      }
      pending.add(chunk)
      setTimeout(take, 20, chunk, taken)
      return false
    },
    end: (taken) => {
      ended.push(taken)
    },
  }
}

describe(drained, () => {
  it('waits until a pipe has taken in every write before, which an empty write does not tell', async () => {
    expect.hasAssertions()
    const order: string[] = []
    const stream = pipe(order)
    stream.write('the last line', () => {
      // Taken
    })
    await drained(stream)
    order.push('drained')
    expect(order).toStrictEqual(['taken the last line', 'drained'])
  })

  it('never ends a terminal, which takes what is written as it comes', async () => {
    expect.hasAssertions()
    const calls: string[] = []
    const terminal = {
      isTTY: true,
      write: (chunk: string, taken: () => void): boolean => {
        calls.push(`write ${JSON.stringify(chunk)}`)
        taken()
        return true
      },
      end: (): void => {
        calls.push('end')
      },
    }
    await drained(terminal)
    expect(calls).toStrictEqual(['write ""'])
  })

  it('waits no longer than the limit for a stream that never takes anything in', async () => {
    expect.hasAssertions()
    const stream = { write: (): boolean => false, end: (): void => undefined }
    const started = performance.now()
    await drained(stream, 50)
    expect(performance.now() - started).toBeGreaterThanOrEqual(45)
  })
})
