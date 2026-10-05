import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { mapLimited } from './limited.js'

// Work that records how many items were under way at once; a later item ends sooner
function counted(): {
  readonly work: (item: number) => Promise<number>
  readonly most: () => number
} {
  const state = { running: 0, most: 0 }
  const work = async (item: number): Promise<number> => {
    state.running += 1
    state.most = Math.max(state.most, state.running)
    await sleep((5 - item) * 5)
    state.running -= 1
    return item * 10
  }
  return { work, most: () => state.most }
}

// Work that fails on its first item, recording every item it was given
const failingFirst =
  (started: number[]) =>
  async (item: number): Promise<number> => {
    started.push(item)
    await Promise.resolve()
    if (started.length === 1) {
      throw new Error('no status')
    }
    return item
  }

describe(mapLimited, () => {
  it('keeps at most the limit under way and gives the results in the order of the items', async () => {
    expect.hasAssertions()
    const { work, most } = counted()
    await expect(mapLimited([1, 2, 3, 4, 5], 2, work)).resolves.toStrictEqual([10, 20, 30, 40, 50])
    expect(most()).toBe(2)
  })

  it('fails as the first failing item does and starts no item after it', async () => {
    expect.hasAssertions()
    const started: number[] = []
    await expect(mapLimited([1, 2, 3, 4], 1, failingFirst(started))).rejects.toThrow('no status')
    expect(started).toStrictEqual([1])
  })

  it('gives nothing for no items', async () => {
    expect.hasAssertions()
    await expect(mapLimited([], 2, counted().work)).resolves.toStrictEqual([])
  })
})
