import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createKeyedQueue } from './keyed-queue.js'

// Work that logs when it starts and when it ends, with a turn of the event loop in between
function logging(log: string[], name: string): () => Promise<string> {
  return async () => {
    log.push(`${name} starts`)
    await nextTurn()
    log.push(`${name} ends`)
    return name
  }
}

async function failing(): Promise<string> {
  await nextTurn()
  throw new Error('boom')
}

describe(createKeyedQueue, () => {
  it('runs the work of one key one after the other, in the order it came', async () => {
    expect.hasAssertions()
    const enqueue = createKeyedQueue()
    const log: string[] = []
    const results = await Promise.all([
      enqueue('k', logging(log, 'a')),
      enqueue('k', logging(log, 'b')),
      enqueue('k', logging(log, 'c')),
    ])
    expect(results).toStrictEqual(['a', 'b', 'c'])
    expect(log).toStrictEqual(['a starts', 'a ends', 'b starts', 'b ends', 'c starts', 'c ends'])
  })

  it('lets the work of different keys overlap', async () => {
    expect.hasAssertions()
    const enqueue = createKeyedQueue()
    const log: string[] = []
    await Promise.all([enqueue('one', logging(log, 'a')), enqueue('two', logging(log, 'b'))])
    expect(log).toStrictEqual(['a starts', 'b starts', 'a ends', 'b ends'])
  })

  it('goes on with the next work after work that failed', async () => {
    expect.hasAssertions()
    const enqueue = createKeyedQueue()
    const first = enqueue('k', failing)
    const second = enqueue('k', logging([], 'b'))
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe('b')
  })
})
